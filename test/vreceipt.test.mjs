// Verification Receipt — 검증을 durable·provenance 봉인·self-hash 아티팩트로. 결정론 확인.
// `node test/vreceipt.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildVerificationReceipt } from "../dist/vreceipt.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const base = {
  surface: "research", inputFile: "report.json", inputRaw: '{"a":1}',
  subject: "Q", provenance: { model: "claude-opus-4-8" },
  results: [{ statement: "s", verdict: "verified" }],
  summary: { verified: 1, failed: 0, advisory: 0 }, verdict: "pass",
  verifiedAt: "2026-07-01T00:00:00.000Z",
};
const r = buildVerificationReceipt(base);

check("구조: kind·verdict·schemaVersion", () => {
  assert.equal(r.kind, "verification-receipt");
  assert.equal(r.verdict, "pass");
  assert.ok(typeof r.schemaVersion === "string" && r.schemaVersion.length);
});
check("입력 봉인: input.sha256 = 입력원문 해시", () => {
  assert.equal(r.input.sha256, createHash("sha256").update('{"a":1}').digest("hex"));
});
check("provenance 기록됨(자가보고)", () => assert.equal(r.provenance.model, "claude-opus-4-8"));
check("self contentHash 결정론 재계산 일치", () => {
  const { contentHash, ...body } = r;
  assert.equal(contentHash, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});
check("결정론: 같은 입력·같은 verifiedAt → 같은 contentHash", () => {
  assert.equal(buildVerificationReceipt(base).contentHash, r.contentHash);
});
check("입력 다르면 contentHash 달라짐(변조탐지)", () => {
  assert.notEqual(buildVerificationReceipt({ ...base, inputRaw: '{"a":2}' }).contentHash, r.contentHash);
});
check("provenance null 허용", () => {
  const r3 = buildVerificationReceipt({ ...base, provenance: null });
  assert.equal(r3.provenance, null);
});

if (fail.length) { console.error(`vreceipt: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`vreceipt: ${pass} pass ✅`);
