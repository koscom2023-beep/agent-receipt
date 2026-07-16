// P0-3 (정본 2026-07-16): `.agent-guard/` 경로 분류 단일 원천.
//
// 이 테스트가 박제하는 실측 사실(2026-07-16 promptia 전수 재분석):
//   · 불합격이 지목한 경로 938건 중 .agent-guard/ 하위는 728건이었다.
//   · 그런데 그중 도구가 **실제로 쓰는** 파일은 decisionlog.jsonl 뿐이었다(31건).
//     나머지 697건은 세션이 손으로 쓴 claims/council 입력, 백업, 외부 산출물(vreceipts)이다.
//   · 즉 "허위 경보의 대부분이 도구 자기 출력" 이라는 초판 진단은 틀렸다.
//     자기 출력을 뺀다고 경보가 74% 사라지지 않는다. 사라지게 만들려면 남의 파일까지 숨겨야 하고,
//     그건 경보를 없앤 게 아니라 눈을 감는 것이다. 그래서 UNKNOWN 은 계속 드러낸다.
import assert from "node:assert";
import { classifyAgentGuardPath, isToolOutput, isControlPlane } from "../dist/agentguard.js";

const cls = classifyAgentGuardPath;

// ── PRODUCT_CHANGE: .agent-guard/ 밖은 전부 평범한 제품 변경 ──
assert.equal(cls("src/app.ts"), "PRODUCT_CHANGE");
assert.equal(cls(".env"), "PRODUCT_CHANGE", "금지 파일도 분류상으론 제품 변경. 숨기는 경로가 아니다");
assert.equal(cls(".agent-guardian/x.json"), "PRODUCT_CHANGE", "접두가 비슷해도 우리 디렉터리가 아니다");

// ── RUNTIME_OUTPUT: 도구가 자동으로 쓰는 것만. 근거는 소스의 쓰기 코드 ──
for (const p of [
  ".agent-guard/session.json",
  ".agent-guard/receipts/receipt-x.json",
  ".agent-guard/keys/public.pem",
  ".agent-guard/audit-packs/p/x.json",
  ".agent-guard/notes/note-x.json",
  ".agent-guard/decisions/decision-x.json",
  ".agent-guard/ledger.jsonl",
  ".agent-guard/decisionlog.jsonl",
  ".agent-guard/dashboard.html",
  ".agent-guard/inbox.html",
  ".agent-guard/capture.jsonl",
  ".agent-guard/capture.head.json",
  ".agent-guard/tap/log.jsonl",
  ".agent-guard/anchors/x.dsse.json",
  ".agent-guard/proof-2026-06-30.html",
  ".agent-guard/x.sig.json",
  ".agent-guard/y.approval.json",
]) {
  assert.equal(cls(p), "RUNTIME_OUTPUT", p);
  assert.ok(isToolOutput(p), `${p} 는 범위 판정에서 빠져야 한다`);
}

// ── CONTROL_PLANE: 판정 규칙을 바꾸는 파일. 절대 조용히 사라지면 안 된다 ──
for (const p of [".agent-guard/contract.yaml", ".agent-guard/policy.yaml", ".agent-guard/README.md", ".agent-guard/extra.yml"]) {
  assert.equal(cls(p), "CONTROL_PLANE", p);
  assert.ok(isControlPlane(p));
  assert.ok(!isToolOutput(p), `🔴 ${p} 를 제외하면 에이전트가 심판 규칙을 고쳐도 아무도 모른다`);
}
// 하위 디렉터리 yaml 은 제어가 아니다(넓히면 산출물까지 제어로 오분류).
assert.notEqual(cls(".agent-guard/audit-packs/meta.yaml"), "CONTROL_PLANE");

// ── UNKNOWN_AGENT_GUARD: 도구가 쓰지 않는 것. 정체를 밝히되 숨기지 않는다 ──
// promptia 실측에서 경보의 대부분을 차지한 실제 경로들이다.
for (const p of [
  ".agent-guard/commit-claims-scanfix.json",
  ".agent-guard/council-saveloop.json",
  ".agent-guard/recon-claims-scanfix.json",
  ".agent-guard/vreceipts/council-20260703.json",
  ".agent-guard/evidence-browser.html",
  ".agent-guard/e2e-identity-probe.ts",
  ".agent-guard/ghost-cleanup-backup-append.json",
]) {
  assert.equal(cls(p), "UNKNOWN_AGENT_GUARD", p);
  assert.ok(!isToolOutput(p), `🔴 ${p} 는 도구가 쓴 적 없다. 자기 출력이라 부르며 숨기면 그게 거짓말이다`);
}

// 🔑 vreceipts 는 도구가 읽기만 한다(graph 기본 입력·share-proof --evidence-dir).
//    읽는다는 이유로 '자기 출력' 처리하면, 남이 넣은 증거를 도구가 만든 척하는 것이 된다.
assert.ok(!isToolOutput(".agent-guard/vreceipts/research-commit-20260703.json"));

// ── 분류는 상호배타 + 전역 전수(빠지는 경로 없음) ──
const ALL = ["PRODUCT_CHANGE", "RUNTIME_OUTPUT", "CONTROL_PLANE", "UNKNOWN_AGENT_GUARD"];
for (const p of ["src/a.ts", ".agent-guard/session.json", ".agent-guard/contract.yaml", ".agent-guard/zzz-mystery.bin"]) {
  assert.ok(ALL.includes(cls(p)), `${p} 는 반드시 네 분류 중 하나`);
}
// isToolOutput 은 RUNTIME_OUTPUT 과 정확히 같다(두 번째 정의를 만들지 않는다).
for (const p of ["src/a.ts", ".agent-guard/contract.yaml", ".agent-guard/session.json", ".agent-guard/mystery.json"]) {
  assert.equal(isToolOutput(p), cls(p) === "RUNTIME_OUTPUT", p);
}

console.log("agentguard-class.test.mjs OK");
