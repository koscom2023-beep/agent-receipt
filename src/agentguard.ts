// `.agent-guard/` 경로 분류기 — 단일 원천(SSOT).
//
// 왜 하나로 모으는가: verify · evidence · status · capture 가 각자 glob 을 들고 있으면
// 몇 버전 뒤 같은 경로를 놓고 판정이 갈라진다. 소비자는 전부 이 함수만 쓴다.
//
// 왜 `.agent-guard/**` 전체 무시가 답이 아닌가(2026-07-16 owner 결정):
// 이 디렉터리에는 성격이 다른 세 가지가 섞여 있다.
//   1) 도구가 자동으로 만든 실행 출력 — 사람 작업물이 아니므로 범위 판정에서 빼야 한다.
//   2) 사람이 고치는 제어 파일(contract/policy) — 판정 규칙 자체를 바꾸므로 오히려 더 크게 봐야 한다.
//   3) 그 밖의 것 — 세션이 손으로 쓴 1회성 입력, 백업, 외부 도구 산출물. 뭔지 모르면 숨기지 않는다.
// 전체를 무시하면 2)와 3)이 같이 사라진다. 그건 경보를 없앤 게 아니라 눈을 감은 것이다.
//
// 분류 기준은 "누가 썼는가"다. agent-receipt 소스에 쓰기 코드가 있는 경로만 RUNTIME_OUTPUT 이다.
// 도구가 읽기만 하는 경로(vreceipts 등)를 '자기 출력'이라 부르면 그건 거짓말이다.

/** 경로 분류. 소비자는 이 네 값만 보고 판단한다. */
export type AgentGuardClass =
  | "PRODUCT_CHANGE" // .agent-guard/ 밖. 평범한 제품 변경이므로 기존 규칙 그대로.
  | "RUNTIME_OUTPUT" // 도구가 자동 생성한 실행 출력. 범위/변경량 판정에서 제외.
  | "CONTROL_PLANE" // 판정 규칙에 영향을 주는 제어 파일. 제외 금지 + 별도 신호.
  | "UNKNOWN_AGENT_GUARD"; // .agent-guard/ 안이지만 도구가 쓰지 않는 것. 제외 금지(정체 모르면 안 숨긴다).

const PREFIX = ".agent-guard/";

/** verify 가 노이즈에서 제외할 자기 제어 파일 — session.json "만"(.agent-guard/** 전체 제외 아님). */
export const SESSION_REL_PATH = ".agent-guard/session.json";

// 도구가 실제로 쓰는 디렉터리(코드 근거를 주석에 남긴다 — 근거 없는 제외 금지).
const RUNTIME_DIRS = [
  "receipts/", // receiptStore.ts RECEIPTS_REL
  "keys/", // keys.ts KEYS_REL
  "audit-packs/", // nextcmd.ts / auditpack.ts
  "notes/", // note.ts
  "decisions/", // note.ts
  "tap/", // mcp-tap 로그·커서·sidecar
  "anchors/", // anchor.ts / predicate.ts
  "completions/", // completion.ts — Stop 훅이 저장하는 최종 답변 원문·source·claim(로컬 전용)
];

// 도구가 실제로 쓰는 단일 파일.
const RUNTIME_FILES = new Set([
  SESSION_REL_PATH, // start.ts / begin.ts
  ".agent-guard/ledger.jsonl",
  ".agent-guard/decisionlog.jsonl", // council.ts appendDecisionLog (append-only 해시 체인)
  ".agent-guard/dashboard.html", // dashboard.ts 기본 out
  ".agent-guard/inbox.html", // inbox.ts --out 안내 기본값
  ".agent-guard/capture.jsonl", // capture.ts
  ".agent-guard/capture.head.json", // capture.ts
  ".agent-guard/pending-completion.json", // completion.ts — done 이 만드는 완료 보고 대기 표식
]);

// 사람이 고치는 제어 파일. 조용히 제외하면 안 되는 쪽(에이전트가 심판 규칙을 바꾼 것이므로).
const CONTROL_FILES = new Set([
  ".agent-guard/contract.yaml",
  ".agent-guard/policy.yaml",
  ".agent-guard/README.md", // init.ts 가 만드는 에이전트 지침
]);

/**
 * 경로 하나를 분류한다. 순수 함수(디스크 접근 없음). 입력은 저장소 상대 경로(POSIX 구분자).
 */
export function classifyAgentGuardPath(f: string): AgentGuardClass {
  if (!f.startsWith(PREFIX)) return "PRODUCT_CHANGE";

  if (CONTROL_FILES.has(f)) return "CONTROL_PLANE";
  // 최상위 *.yaml / *.yml 은 제어 설정으로 본다(계약/정책의 형제 파일).
  // 하위 디렉터리는 포함하지 않는다 — 넓히면 산출물 yaml 까지 제어로 오분류된다.
  const rest = f.slice(PREFIX.length);
  if (!rest.includes("/") && (rest.endsWith(".yaml") || rest.endsWith(".yml"))) return "CONTROL_PLANE";

  if (RUNTIME_FILES.has(f)) return "RUNTIME_OUTPUT";
  if (RUNTIME_DIRS.some((d) => rest.startsWith(d))) return "RUNTIME_OUTPUT";
  // share-proof 산출물(shareproof.ts 기본 out)과 도구가 만든 서명/승인 사이드카.
  if (rest.startsWith("proof-") && rest.endsWith(".html")) return "RUNTIME_OUTPUT";
  if (f.endsWith(".sig.json") || f.endsWith(".approval.json")) return "RUNTIME_OUTPUT";

  // 나머지: 세션이 손으로 쓴 claims/council 입력, 백업, 외부 도구 산출물(vreceipts 등).
  // 도구가 쓰지 않으므로 자기 출력이 아니다. 제외하지 않고 정체를 밝힌 채 남긴다.
  return "UNKNOWN_AGENT_GUARD";
}

/**
 * 범위/변경량 판정에서 뺄 것인가. RUNTIME_OUTPUT 만 true.
 * CONTROL_PLANE 과 UNKNOWN 은 계속 추적한다(제외는 경보를 없애는 게 아니라 눈을 감는 것).
 */
export function isToolOutput(f: string): boolean {
  return classifyAgentGuardPath(f) === "RUNTIME_OUTPUT";
}

/** 판정 규칙에 영향을 주는 제어 파일인가. 별도 신호(CONTROL_PLANE_TOUCHED)로 올린다. */
export function isControlPlane(f: string): boolean {
  return classifyAgentGuardPath(f) === "CONTROL_PLANE";
}
