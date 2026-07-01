// Evidence Kernel(공유 코어) — 인용 대조 순수 커널. research·council 이 재사용하는 그 코어.
// `node test/evidencekernel.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeForCitation, verifyCitationInText, citationStatus, parseNumbersFromText, recompute, numberStatus, canonicalizeDate, dateStatus, linkStatus, evaluateClaim, hashStatus, CHECK_KINDS, claimSchema, SCHEMA_VERSION } from "../dist/evidencekernel.js";
const sha = (s) => createHash("sha256").update(s).digest("hex");

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

check("normalize: 공백 collapse+trim", () => assert.equal(normalizeForCitation("  a   b\n c "), "a b c"));
check("verify: 정확한 부분문자열", () => assert.equal(verifyCitationInText("sky is blue", "the sky is blue today"), true));
check("verify: 공백차이 정규화 일치", () => assert.equal(verifyCitationInText("sky   is\nblue", "sky is blue"), true));
check("verify: 날조는 false", () => assert.equal(verifyCitationInText("sky is green", "sky is blue"), false));
check("verify: 빈 인용 false", () => assert.equal(verifyCitationInText("  ", "x"), false));

check("status verified", () => assert.equal(citationStatus("hello world", "say hello world now"), "verified"));
check("status not-found", () => assert.equal(citationStatus("ghost", "real only"), "not-found"));
check("status no-source: source null", () => assert.equal(citationStatus("x", null), "no-source"));
check("status no-source: 빈 인용", () => assert.equal(citationStatus("", "some source"), "no-source"));

// ── 수치 커널 ──
check("parseNumbers: 콤마·소수·음수", () => assert.deepEqual(parseNumbersFromText("value 1,234.5 and -3 done"), [1234.5, -3]));
check("recompute sum", () => assert.equal(recompute("sum", [1, 2, 3]), 6));
check("recompute mean", () => assert.equal(recompute("mean", [2, 4]), 3));
check("recompute percent", () => assert.equal(recompute("percent", [1, 4]), 25));
check("recompute ratio 0분모 → null", () => assert.equal(recompute("ratio", [1, 0]), null));
check("number 모드A verified: 출처에 실재", () => assert.equal(numberStatus(42, { source: "the answer is 42 today" }), "verified"));
check("number 모드A mismatch: 출처에 없음", () => assert.equal(numberStatus(99, { source: "the answer is 42" }), "mismatch"));
check("number 모드B verified: 재계산 일치", () => assert.equal(numberStatus(6, { op: "sum", operands: [1, 2, 3] }), "verified"));
check("number 모드B mismatch: 재계산 불일치", () => assert.equal(numberStatus(7, { op: "sum", operands: [1, 2, 3] }), "mismatch"));
check("number no-basis: stated null", () => assert.equal(numberStatus(null, { source: "42" }), "no-basis"));
check("number no-basis: 근거 없음", () => assert.equal(numberStatus(5, {}), "no-basis"));
check("number eps 허용오차", () => assert.equal(numberStatus(3.14, { op: "sum", operands: [3.14], eps: 0.001 }), "verified"));

// ── 날짜 커널 ──
check("canonicalizeDate: ISO", () => assert.equal(canonicalizeDate("2026-1-5"), "2026-01-05"));
check("canonicalizeDate: Mon DD, YYYY", () => assert.equal(canonicalizeDate("Jan 5, 2026"), "2026-01-05"));
check("canonicalizeDate: DD Mon YYYY", () => assert.equal(canonicalizeDate("5 January 2026"), "2026-01-05"));
check("canonicalizeDate: 파싱불가 → null", () => assert.equal(canonicalizeDate("last tuesday"), null));
check("date verified: 다른 형식 같은 날 일치", () => assert.equal(dateStatus("2026-01-05", "published on Jan 5, 2026 here"), "verified"));
check("date mismatch: 다른 날", () => assert.equal(dateStatus("2026-01-05", "published on 2026-02-01"), "mismatch"));
check("date no-basis: 파싱불가 stated", () => assert.equal(dateStatus("someday", "2026-01-05"), "no-basis"));

// ── 링크 커널 ──
check("link valid: https", () => assert.equal(linkStatus("https://example.com/x"), "valid"));
check("link valid: http", () => assert.equal(linkStatus("http://a.b"), "valid"));
check("link invalid: 스킴 아님", () => assert.equal(linkStatus("ftp://x"), "invalid"));
check("link invalid: 형식 깨짐", () => assert.equal(linkStatus("not a url"), "invalid"));

// ── evaluateClaim (표준 포맷 단일 의미론) ──
check("eval: 인용 verified → verified", () => {
  const e = evaluateClaim({ quotedText: "sky is blue" }, "the sky is blue");
  assert.equal(e.verified, true); assert.equal(e.failed, false); assert.equal(e.citation, "verified");
});
check("eval: 수치 mismatch → failed", () => {
  const e = evaluateClaim({ statedValue: 99, sourceText: undefined, op: "sum", operands: [1, 2] }, null);
  assert.equal(e.failed, true); assert.equal(e.number, "mismatch");
});
check("eval: 날짜 verified", () => {
  const e = evaluateClaim({ statedDate: "2026-01-05" }, "on Jan 5, 2026");
  assert.equal(e.date, "verified"); assert.equal(e.verified, true);
});
check("eval: link invalid → failed", () => {
  const e = evaluateClaim({ link: "not a url" }, null);
  assert.equal(e.link, "invalid"); assert.equal(e.failed, true);
});
check("eval: link valid 는 advisory(verified 아님)", () => {
  const e = evaluateClaim({ link: "https://x.y" }, null);
  assert.equal(e.link, "valid"); assert.equal(e.verified, false); assert.equal(e.failed, false);
});
check("eval: 복합 — 인용+수치 둘 다 verified", () => {
  const e = evaluateClaim({ quotedText: "42 items", statedValue: 42, sourceText: "we found 42 items" }, "we found 42 items");
  assert.equal(e.citation, "verified"); assert.equal(e.number, "verified"); assert.equal(e.verified, true);
});

// ── 해시 커널 ──
check("hash verified: content 해시 일치", () => assert.equal(hashStatus(sha("hello"), "hello"), "verified"));
check("hash mismatch: 다른 content", () => assert.equal(hashStatus(sha("hello"), "world"), "mismatch"));
check("hash no-basis: content null", () => assert.equal(hashStatus(sha("x"), null), "no-basis"));
check("hash 대소문자 무관", () => assert.equal(hashStatus(sha("hello").toUpperCase(), "hello"), "verified"));
check("eval hash verified(레지스트리 경유)", () => {
  const e = evaluateClaim({ statedHash: sha("data"), content: "data" }, null);
  assert.equal(e.hash, "verified"); assert.equal(e.verified, true);
});
check("eval hash mismatch → failed", () => {
  const e = evaluateClaim({ statedHash: sha("data"), content: "other" }, null);
  assert.equal(e.hash, "mismatch"); assert.equal(e.failed, true);
});

// ── Evidence Specification ──
check("CHECK_KINDS: 레지스트리에 hash 확장 반영", () => assert.ok(CHECK_KINDS.includes("hash") && CHECK_KINDS.includes("citation")));
check("claimSchema: schemaVersion + 구조 + checkKinds", () => {
  const s = claimSchema();
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.ok(s.properties && s.properties.quotedText && s.properties.statedHash);
  assert.ok(Array.isArray(s.checkKinds) && s.checkKinds.includes("hash"));
});

if (fail.length) { console.error(`evidencekernel: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`evidencekernel: ${pass} pass ✅`);
