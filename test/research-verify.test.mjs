// research 인용검증 커널 — quotedText 가 출처의 리터럴 부분문자열인지 결정론 대조(비-LLM).
// `node test/research-verify.test.mjs`.
import assert from "node:assert/strict";
import { verifyCitationInText, normalizeForCitation, checkClaimCitation } from "../dist/research.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// ── 정규화: 공백 collapse + trim ──
check("normalize: 공백 collapse", () => assert.equal(normalizeForCitation("a   b\n c"), "a b c"));
check("normalize: trim", () => assert.equal(normalizeForCitation("  x  "), "x"));

// ── 커널: 실재 인용 pass / 날조 fail ──
check("verified: 정확한 부분문자열", () =>
  assert.equal(verifyCitationInText("the sky is blue", "Studies show the sky is blue today."), true));
check("verified: 공백 차이는 정규화되어 일치", () =>
  assert.equal(verifyCitationInText("the sky   is\nblue", "the sky is blue"), true));
check("not-found: 날조 인용은 출처에 없음", () =>
  assert.equal(verifyCitationInText("the sky is green", "the sky is blue"), false));
check("not-found: 빈 인용은 검증 불가(false)", () =>
  assert.equal(verifyCitationInText("   ", "anything"), false));
check("not-found: 인용이 출처보다 길면 false", () =>
  assert.equal(verifyCitationInText("a very long quote not present", "short"), false));

// ── checkClaimCitation: 상태 판정(verified / not-found / no-source) ──
check("status verified: sourceText 인라인에 인용 실재", () =>
  assert.equal(checkClaimCitation({ quotedText: "hello world", sourceText: "say hello world now" }), "verified"));
check("status not-found: sourceText 있으나 인용 없음", () =>
  assert.equal(checkClaimCitation({ quotedText: "ghost quote", sourceText: "real text only" }), "not-found"));
check("status no-source: 출처 없음", () =>
  assert.equal(checkClaimCitation({ quotedText: "orphan" }), "no-source"));
check("status no-source: 인용 없음", () =>
  assert.equal(checkClaimCitation({ sourceText: "some source" }), "no-source"));
check("status no-source: 못 읽는 sourceFile", () =>
  assert.equal(checkClaimCitation({ quotedText: "x", sourceFile: "/no/such/file/xyz-987.txt" }), "no-source"));

if (fail.length) { console.error(`research-verify: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`research-verify: ${pass} pass ✅`);
