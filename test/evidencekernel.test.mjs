// Evidence Kernel(공유 코어) — 인용 대조 순수 커널. research·council 이 재사용하는 그 코어.
// `node test/evidencekernel.test.mjs`.
import assert from "node:assert/strict";
import { normalizeForCitation, verifyCitationInText, citationStatus } from "../dist/evidencekernel.js";

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

if (fail.length) { console.error(`evidencekernel: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`evidencekernel: ${pass} pass ✅`);
