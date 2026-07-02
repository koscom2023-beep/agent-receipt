// 멀티에이전트 envelope 정규화 토대(7차 council) — 여러 코딩 에이전트 훅 stdin 을 공통 모양으로.
// 잠금: Claude/Codex passthrough · Copilot camelCase alias · Cursor conversation_id · source 라벨 · 미지원 tool [](mcp 는 Phase7 이름만 포착)·source hash 조건부(pre-source 불변).
// 합성 payload(공식 문서 형식)로 검증 — 실 에이전트 미구동(best-effort). `node test/multiagent-envelope.test.mjs`.
import assert from "node:assert/strict";
import { normalizeEnvelope, classifyEvent, captureEntryHash, aggregateActions } from "../dist/capture.js";

let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

// 1) Claude / Codex / Copilot(PascalCase) — 키 동일 → passthrough
check("passthrough — tool_name/tool_input/session_id 그대로", () => {
  const e = normalizeEnvelope({ tool_name: "Read", tool_input: { file_path: ".env" }, session_id: "s1" });
  assert.equal(e.tool_name, "Read");
  assert.deepEqual(e.tool_input, { file_path: ".env" });
  assert.equal(e.sessionId, "s1");
  assert.equal(e.source, undefined);
});

// 2) Copilot camelCase(toolName/toolArgs/sessionId) → 정규화
check("Copilot camelCase → tool_name/tool_input/sessionId", () => {
  const e = normalizeEnvelope({ toolName: "Bash", toolArgs: { command: "curl http://x" }, sessionId: "s2" });
  assert.equal(e.tool_name, "Bash");
  assert.deepEqual(e.tool_input, { command: "curl http://x" });
  assert.equal(e.sessionId, "s2");
});

// 3) Cursor preToolUse — conversation_id → sessionId
check("Cursor conversation_id → sessionId", () => {
  const e = normalizeEnvelope({ tool_name: "Write", tool_input: { file_path: "a.ts" }, conversation_id: "c1" });
  assert.equal(e.sessionId, "c1");
});

// 4) source(자기신고 라벨) — source/agent 키
check("source / agent → source", () => {
  assert.equal(normalizeEnvelope({ tool_name: "Read", tool_input: {}, source: "codex" }).source, "codex");
  assert.equal(normalizeEnvelope({ tool_name: "Read", tool_input: {}, agent: "cursor" }).source, "cursor");
});

// 5) 정규화 → classifyEvent end-to-end (camelCase 입력도 분류됨)
check("camelCase 입력이 정규화 후 classifyEvent 로 분류", () => {
  const recs = classifyEvent(normalizeEnvelope({ toolName: "Read", toolArgs: { file_path: ".env" } }), "post", "t");
  assert.equal(recs.length, 1);
  assert.equal(recs[0].op, "read");
  assert.equal(recs[0].path, ".env");
});

// 6) 미지원 tool(apply_patch 등) → 미포착(크래시 0). MCP 는 Phase7 편입 — 이름만(command) 포착.
check("미지원 tool → [] (apply_patch) · mcp__* 는 이름만 포착(Phase7)", () => {
  assert.equal(classifyEvent(normalizeEnvelope({ tool_name: "apply_patch", tool_input: { patch: "x" } }), "post", "t").length, 0);
  const m = classifyEvent(normalizeEnvelope({ tool_name: "mcp__foo__bar", tool_input: { secret: "v" } }), "post", "t");
  assert.equal(m.length, 1);
  assert.equal(m[0].op, "command");
  assert.ok(!JSON.stringify(m).includes("secret")); // 인자=값 미저장
});

// 7) 빈/이상 payload → tool_name "" → [] (방어)
check("빈 payload 방어", () => {
  assert.equal(normalizeEnvelope(null).tool_name, "");
  assert.equal(normalizeEnvelope({}).tool_name, "");
  assert.equal(classifyEvent(normalizeEnvelope({}), "post", "t").length, 0);
});

// 8) source hash 조건부 — source 없는 레코드는 pre-source 와 hash 동일(체인 불변)
check("source 없으면 hash 불변(pre-source 호환)", () => {
  const r = { ts: "t", phase: "post", tool: "Read", op: "read", path: ".env", seq: 1 };
  assert.equal(captureEntryHash(r), captureEntryHash({ ...r, source: undefined }), "source undefined 가 hash 를 바꿈");
  assert.notEqual(captureEntryHash(r), captureEntryHash({ ...r, source: "codex" }), "source 가 hash 에 반영 안 됨");
});

// 9) source 는 CaptureAction(영수증)에 미전파 — byte-safe
check("source 는 actions 에 누출 안 됨", () => {
  const a = aggregateActions([{ ts: "t", phase: "post", tool: "Read", op: "read", path: ".env", source: "codex", seq: 1 }]).actions[0];
  assert.equal(a.source, undefined, "source 가 CaptureAction 으로 누출(영수증 회귀 위험)");
  assert.equal(a.flag, "READ_SECRET_FILE");
});

if (fail.length) {
  console.error(`multiagent-envelope: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`multiagent-envelope: ${pass} pass, 0 fail`);
