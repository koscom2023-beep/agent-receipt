import { isAbsolute, relative, sep } from "node:path";
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
  origin?: "contract.denied_paths" | "policy.forbidAlways";
  reason?: string; // deny 시 에이전트에게 노출되는 문장(재시도 금지 + 해제 경로 포함)
}

export interface GuardTarget {
  op: string;
  path?: string;
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
