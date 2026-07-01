// #7 — 영수증 provenance 에 에이전트 세션 기록(CLAUDE_CODE_SESSION_ID). 사람 커밋=null.
// `node test/env-session.test.mjs`.
import assert from "node:assert/strict";
import { captureEnvironment } from "../dist/environment.js";

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

const orig = process.env.CLAUDE_CODE_SESSION_ID;

check("세션 env 설정 시 agentSession 에 기록", () => {
  process.env.CLAUDE_CODE_SESSION_ID = "sess-abc-123";
  assert.equal(captureEnvironment().agentSession, "sess-abc-123");
});

check("세션 env 없으면 null(사람 커밋 = 에이전트 세션 아님)", () => {
  delete process.env.CLAUDE_CODE_SESSION_ID;
  assert.equal(captureEnvironment().agentSession, null);
});

check("공백만이면 null(trim)", () => {
  process.env.CLAUDE_CODE_SESSION_ID = "   ";
  assert.equal(captureEnvironment().agentSession, null);
});

// 복원
if (orig === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
else process.env.CLAUDE_CODE_SESSION_ID = orig;

if (fail.length) {
  console.error(`env-session: ${pass} pass, ${fail.length} FAIL`);
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`env-session: ${pass} pass ✅`);
