import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { minimatch } from "minimatch";
import { loadPolicySafe } from "./policy.js";
import { discoverContract } from "./discover.js";
import { loadContract } from "./schema.js";

// ── 실시간 스코프 가드 (council 2026-07-03 결정 1~3 · 스모크 4/4 실측 후 구현) ──
// capture 의 PreToolUse 시점에 write/delete 대상 경로를 contract.scope.denied_paths ∪ policy.forbidAlways 와 대조.
// 기본 warn(레코드에 표시만·행동 불변) · policy.yaml `guard: block` opt-in 일 때만 deny(도구 실행 전 차단) 방출.
// fail-open: 가드 평가의 어떤 실패도 deny 를 만들지 않는다(가드 없던 것과 동일 동작) — 오탐 차단으로 세션이
// 멈추는 비용이 경고 하나 놓치는 비용보다 크다. 계약/policy 형식 오류는 verify/done/policy check 가 이미 보고.
// 보증 정직: Claude Code PreToolUse 훅 표면 한정 — Bash 우회·훅 미설치·--dangerously-skip-permissions·
// 타 에이전트는 범위 밖(차단이 아니라 이 표면의 차단). 읽기는 대상 아님(READ_SECRET_FILE 표시·harness 권한이 담당).

export interface GuardVerdict {
  action: "none" | "warn" | "deny";
  rule?: string; // 매칭된 glob
  origin?: "contract.denied_paths" | "policy.forbidAlways" | "policy.forbid_actions";
  reason?: string; // deny 시 에이전트에게 노출되는 문장(재시도 금지 + 해제 경로 포함)
}

export interface GuardTarget {
  op: string;
  path?: string;
  cmdKind?: string; // v0.21 결정10 — 명령 분류(capture 첫 토큰 파스) — forbid_actions 대조용
}

// 패턴의 기준틀 = 프로젝트 루트(policy.yaml/contract 가 있는 hook cwd). 실훅 payload 는 절대경로라
// (E2E 실측 2026-07-03: 비-git 디렉터리에서 capture 의 toRel 이 절대경로 유지 → 미매치 → 차단 실패 버그),
// 가드 매칭 직전에 cwd 상대로 정규화한다. cwd 밖 절대경로는 그대로 둠(레포 밖 쓰기는 패턴 범위 밖 — 미매치가 맞음).
function relToCwd(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p;
  const r = relative(cwd, p);
  return (r.startsWith("..") ? p : r).split(sep).join("/");
}

export function evalGuard(t: GuardTarget, cwd: string = process.cwd()): GuardVerdict {
  try {
    // v0.21 결정10 — 행위 클래스 가드(opt-in): 명령 분류/네트워크 op 가 policy.forbid_actions 에 있으면 warn/deny.
    // 정직(자백): 첫 토큰 파스 기반이라 우회 가능(스크립트·별칭·서브셸) — 자물쇠가 아니라 신호등. fail-open 유지.
    const actionClass = t.op === "network" ? "network" : t.op === "command" ? t.cmdKind : undefined;
    if (actionClass) {
      const { policy } = loadPolicySafe(cwd);
      if (policy?.forbid_actions.includes(actionClass as never)) {
        const rule = `policy.forbid_actions:${actionClass}`;
        if ((policy.guard ?? "warn") === "block") {
          return {
            action: "deny",
            rule,
            origin: "policy.forbid_actions",
            reason:
              `[agent-receipt guard] this ${actionClass} action is forbidden by policy forbid_actions. ` +
              `Token-parse based — bypassable by scripts/aliases (a signal, not a lock). Do NOT retry the exact command; report and continue with allowed work. ` +
              `(lift: edit .agent-guard/policy.yaml — remove '${actionClass}' from forbid_actions or set guard: warn)`,
          };
        }
        return { action: "warn", rule, origin: "policy.forbid_actions" };
      }
      if (t.op === "command") return { action: "none" }; // 명령은 여기까지(경로 가드는 write/delete 전용)
    }
    if ((t.op !== "write" && t.op !== "delete") || !t.path) return { action: "none" };
    const target = relToCwd(t.path, cwd);
    const { policy } = loadPolicySafe(cwd);
    let contractDenied: string[] = [];
    try {
      const cp = discoverContract(cwd);
      if (cp) contractDenied = loadContract(cp).scope.denied_paths;
    } catch {
      // 계약 파싱 실패 = 그 근거만 제외(fail-open) — policy 근거는 계속 평가.
    }
    const sources: Array<[NonNullable<GuardVerdict["origin"]>, string[]]> = [
      ["contract.denied_paths", contractDenied],
      ["policy.forbidAlways", policy?.forbidAlways ?? []],
    ];
    const mode: "warn" | "block" = policy?.guard ?? "warn";
    for (const [origin, globs] of sources) {
      for (const gl of globs) {
        if (!minimatch(target, gl, { dot: true })) continue;
        if (mode === "block") {
          return {
            action: "deny",
            rule: gl,
            origin,
            reason:
              `[agent-receipt guard] '${target}' is forbidden by ${origin} pattern '${gl}'. ` +
              `Do NOT retry this exact write — report the block and continue with allowed work. ` +
              `(lift: ${origin === "policy.forbidAlways" ? "edit .agent-guard/policy.yaml — set `guard: warn` or adjust forbidAlways" : "adjust denied_paths in the work contract"})`,
          };
        }
        return { action: "warn", rule: gl, origin };
      }
    }
    return { action: "none" };
  } catch {
    return { action: "none" }; // fail-open(상단 주석) — 가드 내부 오류가 도구 실행을 막으면 안 됨.
  }
}

// ── 루프 개입 (council 2026-07-03 L1~L2) ──
// 신호: *같은 세션*에서 동일 명령(cmdHash)이 사이 파일 쓰기/삭제 0으로 재실행 — 입력이 안 변했으니 결과도
// 같을 공산이 큼. 보수적 휴리스틱임을 자백한다(시간/네트워크/env 의존 명령은 다를 수 있음 — D 반례·dissent 기록).
// 그래서: 대상 test/build/lint 한정 · 이중 opt-in(loop_repeat_threshold 설정 + 행동은 guard 모드) · 기본 warn.
// 성능: 임계 미설정/비대상이면 디스크 안 읽음. 스캔은 뒤에서 앞으로, cmdHash·write 문자열 prefilter 후에만 파싱.
const LOOP_KINDS = new Set(["test", "build", "lint"]);

export interface LoopTarget {
  op: string;
  cmdHash?: string;
  cmdKind?: string;
}

export function evalLoopGuard(t: LoopTarget, sessionId: string | undefined, cwd: string = process.cwd()): GuardVerdict {
  try {
    if (t.op !== "command" || !t.cmdHash || !t.cmdKind || !LOOP_KINDS.has(t.cmdKind)) return { action: "none" };
    if (!sessionId) return { action: "none" }; // 세션 격리 불가면 개입 안 함(교차세션 오탐 방지 — 보수적)
    const { policy } = loadPolicySafe(cwd);
    const threshold = policy?.loop_repeat_threshold;
    if (!threshold) return { action: "none" };
    // 경로 기준은 cwd(policy/contract 와 동일 프레임) — 실훅은 프로젝트 루트에서 돌아 repoRoot 과 일치.
    const f = join(cwd, ".agent-guard", "capture.jsonl");
    let raw = "";
    try {
      raw = readFileSync(f, "utf8");
    } catch {
      return { action: "none" };
    }
    const lines = raw.split("\n");
    let prior = 0; // 마지막 파일변경 이후, 같은 세션의 동일 명령 실행 수(pre 만 — pre/post 이중기록 dedupe)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const maybeWrite = line.includes('"op":"write"') || line.includes('"op":"delete"');
      if (!maybeWrite && !line.includes(t.cmdHash)) continue; // prefilter — 무관 라인은 파싱 안 함
      let r: { phase?: string; op?: string; cmdHash?: string; sessionId?: string };
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (r.sessionId !== sessionId) continue; // 다른 세션은 카운트도 경계도 아님
      if (r.op === "write" || r.op === "delete") break; // 파일변경 = 창 경계(그 뒤 재실행은 정당)
      if (r.phase === "pre" && r.op === "command" && r.cmdHash === t.cmdHash) prior += 1;
    }
    if (prior + 1 < threshold) return { action: "none" };
    const n = prior + 1;
    const rule = `loop:${t.cmdKind}x${n}-no-change`;
    if (policy?.guard === "block") {
      return {
        action: "deny",
        rule,
        reason:
          `[agent-receipt guard] this exact ${t.cmdKind} command already ran ${prior}x in this session with no file changes in between — ` +
          `rerunning without changing anything will likely repeat the result. This is a conservative heuristic ` +
          `(time/network/env-dependent commands can legitimately differ). Change something first, or ask the human. ` +
          `(lift: remove loop_repeat_threshold or set \`guard: warn\` in .agent-guard/policy.yaml)`,
      };
    }
    return { action: "warn", rule };
  } catch {
    return { action: "none" }; // fail-open — 루프 판정 오류가 도구 실행을 막으면 안 됨
  }
}
