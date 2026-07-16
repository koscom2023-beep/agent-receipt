import type { Contract } from "./schema.js";
import { startCore, type SessionKind } from "./start.js";
import { buildPrompt, type PromptVariant } from "./output.js";
import { evalTripwire, tripwireLines } from "./tripwire.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { tapCursorSnapshot } from "./tap.js";

const line = "─".repeat(56);

/**
 * `agent-receipt begin [--cursor|--claude|--generic]` — 작업 시작을 한 명령으로.
 *   policy 확인(있으면) → start(baseline) → prompt 출력 → 다음 명령 안내.
 * start 가 이미 있으면(재시작) baseline 은 건너뛰고 prompt 만 다시 보여준다(편의). exit 0/1.
 */
export function runBegin(contract: Contract, variant: PromptVariant, kind?: SessionKind, objective?: string, cwd: string = process.cwd()): never {
  console.log("");
  console.log(line);
  console.log(`agent-receipt begin: ${contract.id}`);
  console.log(line);

  // 1) policy 상시규칙(있으면) — 시작 시점 관찰(advisory).
  const tw = tripwireLines(evalTripwire(cwd));
  if (tw.length) {
    console.log("상시 규칙(policy):");
    for (const x of tw) console.log(`  ${x}`);
    console.log("");
  }

  // 2) baseline 기록.
  const res = startCore(contract, "begin", cwd, kind, objective);
  if (objective) console.log(`세션 목적(자가보고·미검증): ${objective}`); // 배치A-6 — 기록 사실 고지
  if (!res.ok && res.reason === "denied-dirty") {
    console.error(res.message);
    process.exit(1);
  }
  if (!res.ok && res.reason === "exists") {
    // 강화(0.9): "그대로 사용"이 정찰→구현 전환 시 감사 경계를 섞는 오도였음.
    console.log("⚠️ 기존 baseline(.agent-guard/session.json)이 있습니다.");
    console.log("   같은 작업을 계속하는 경우에만 그대로 두세요.");
    console.log("   새 Phase / 새 작업 / 정찰→구현 전환이면 반드시 `agent-receipt reset` 후 다시 `begin`.");
    console.log("   baseline 을 이어 쓰면 감사 경계가 섞입니다.");
  } else if (res.ok) {
    console.log(res.message);
    // 🔴 과거 capture 를 삭제하지 않는다(P0-3.5 owner 결정: 비파괴 관찰 창).
    //    감사 도구가 새 창을 연다고 과거 관찰을 지우면 안 된다. 새 창 = 경계 저장이지 기록 삭제가 아니다.
    //    옛 기록은 session.captureBoundary(seq)로 stale 처리돼 이번 세션 관찰에서 자동 제외된다.
    //    (capture 파일 무한 성장은 별도 보존 정책 사안 — 명시적 `capture reset` 은 유지된다.)
    try {
      tapCursorSnapshot(cwd); // tap 은 장수 프로세스라 초기화 불가 — 커서 스냅샷이 경계(mcp-tap 결정 1 · 미사용=no-op)
    } catch {
      /* additive — 실패해도 begin 진행 */
    }
  }
  console.log("");

  // 2.5) kind 운영 원칙(정의시만 — 무kind 경로는 기존 출력 불변).
  if (kind) {
    for (const ln of kindGuidance(kind)) console.log(ln);
    console.log("");
  }

  // 3) 에이전트 지시문.
  console.log("── 아래 지시문을 AI 에이전트에 붙여 작업을 시작하세요 ──");
  console.log("");
  console.log(buildPrompt(contract, variant));
  console.log("");
  console.log(line);
  if (kind) {
    console.log("작업이 끝나면:  " + kindEndCommand(kind));
  } else {
    console.log("작업이 끝나면:  agent-receipt done [--claim <claim.json>] [--client]");
  }
  console.log("  " + LIMIT_NOTE);
  console.log(line);
  console.log("");
  process.exit(0);
}

// 0.9: kind 별 운영 원칙(begin 출력 — 사람/에이전트용. verify --json 14키 비접촉).
function kindGuidance(kind: SessionKind): string[] {
  const map: Record<SessionKind, string[]> = {
    recon: [
      "  · 읽기 전용 정찰 — 코드 변경 금지(읽기/검색만).",
      "  · 끝나면 close-recon 으로 변경 0 확인 후 audit-pack + baseline reset.",
    ],
    implementation: [
      "  · 구현 작업 — 끝나면 finish 또는 prepare-commit → 사람이 커밋 → reset.",
      "  · 자동 commit/push 없음.",
    ],
    docs: ["  · 문서 작업 — 제품 코드 변경 금지."],
    test: ["  · 테스트 작업 — 제품 코드 변경 여부를 완료보고에 명확히."],
    "measure-first": [
      "  · 순수 측정기/측정 코드만 — 관측 부착·점수 교체·DB write·pipeline wiring 금지.",
      "  · 도구는 git diff 만 봄 — 의미 위반은 self-report.",
    ],
    "observe-only": [
      "  · 관측(studioLog/fire-and-forget)만 — 차단·점수 교체·DB write·trigger/behavior 변경 금지.",
      "  · 의미 위반은 self-report.",
    ],
    "release-check": [
      "  · 배포 전 read-only 분석 — push/deploy 금지.",
      "  · 분석: agent-receipt release-check --base origin/main",
    ],
  };
  return ["── 작업 종류(kind=" + kind + ") 운영 원칙 ──", ...map[kind]];
}

function kindEndCommand(kind: SessionKind): string {
  if (kind === "recon" || kind === "release-check") {
    return "agent-receipt close-recon   (읽기 전용 — 변경 0 확인 후 audit-pack + reset)";
  }
  return 'agent-receipt finish [--message "..."]   (done+commit-check+audit-pack+커밋블록; 자동 커밋 없음)';
}
