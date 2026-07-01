// Verification Receipt — 증적(기록)·계층화 provenance(verified vs reported)·결정론 receiptId·self-hash.
// `node test/vreceipt.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildVerificationReceipt, tierProvenance } from "../dist/vreceipt.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const prov = tierProvenance({ model: "claude-opus-4-8", author: "x" }); // commit/inputFiles 없음 → verified:{}
const base = {
  surface: "research", inputFile: "report.json", inputRaw: '{"a":1}',
  subject: "Q", provenance: prov, results: [{ statement: "s", verdict: "verified" }],
  summary: { verified: 1, failed: 0, advisory: 0 }, verdict: "pass",
  verifiedAt: "2026-07-01T00:00:00.000Z",
};
const r = buildVerificationReceipt(base);

check("kind·receiptId·means(증적≠증명)", () => {
  assert.equal(r.kind, "verification-receipt");
  assert.ok(typeof r.receiptId === "string" && r.receiptId.length === 64);
  assert.ok(typeof r.means === "string" && r.means.includes("증적"));
});
check("provenance 계층: reported 자가보고 / verified 분리", () => {
  assert.equal(r.provenance.reported.model, "claude-opus-4-8");
  assert.deepEqual(r.provenance.verified, {});
});
check("입력 봉인 sha256", () => assert.equal(r.input.sha256, createHash("sha256").update('{"a":1}').digest("hex")));
check("self contentHash 재계산 일치", () => {
  const { contentHash, ...body } = r;
  assert.equal(contentHash, createHash("sha256").update(JSON.stringify(body)).digest("hex"));
});
check("receiptId 결정론: 타임스탬프 무관(같은 입력·버전·verdict → 같은 ID)", () => {
  const r2 = buildVerificationReceipt({ ...base, verifiedAt: "2027-01-01T00:00:00.000Z" });
  assert.equal(r2.receiptId, r.receiptId); // 같음(타임스탬프 제외)
  assert.notEqual(r2.contentHash, r.contentHash); // 다름(전체 봉인은 타임스탬프 포함)
});
check("receiptId: 입력 다르면 달라짐", () => assert.notEqual(buildVerificationReceipt({ ...base, inputRaw: '{"a":2}' }).receiptId, r.receiptId));
check("receiptId: verdict 다르면 달라짐", () => assert.notEqual(buildVerificationReceipt({ ...base, verdict: "fail" }).receiptId, r.receiptId));

// ── tierProvenance: 자가보고를 verified 로 세탁하지 않음 ──
check("tier: reported null → {verified:{}, reported:null}", () => {
  const t = tierProvenance(null);
  assert.equal(t.reported, null); assert.deepEqual(t.verified, {});
});
check("tier: model 은 reported(verified 아님·세탁 금지)", () => {
  const t = tierProvenance({ model: "gpt" });
  assert.equal(t.reported.model, "gpt");
  assert.equal(t.verified.model, undefined);
});
check("tier: inputFiles 못 읽으면 sha256 null(우리가 실제 해시 시도)", () => {
  const t = tierProvenance({ inputFiles: ["/no/such/file-xyz-987.md"] });
  assert.equal(t.verified.inputFiles[0].sha256, null);
});

if (fail.length) { console.error(`vreceipt: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`vreceipt: ${pass} pass ✅`);
