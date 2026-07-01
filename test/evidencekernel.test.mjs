// Evidence Kernel(공유 코어) — 인용 대조 순수 커널. research·council 이 재사용하는 그 코어.
// `node test/evidencekernel.test.mjs`.
import assert from "node:assert/strict";
import { normalizeForCitation, verifyCitationInText, citationStatus, parseNumbersFromText, recompute, numberStatus } from "../dist/evidencekernel.js";

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

if (fail.length) { console.error(`evidencekernel: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`evidencekernel: ${pass} pass ✅`);
