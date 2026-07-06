// R2 등급(A/B/C) + 보류(abstain) 테스트 — 코어(evidencekernel) additive 의미론이 결정론인가.
// A=커널 재계산(수치·해시·서명) · B=resolved 사실/부분문자열 대조 · C=형식(link). 재계산 > 대조 > 형식.
import assert from "node:assert";
import { evaluateClaim, CHECK_GRADES } from "../dist/evidencekernel.js";

// 등급 매핑(감사 증거 위계)
assert.equal(CHECK_GRADES.number, "A", "수치 재계산=A");
assert.equal(CHECK_GRADES.hash, "A", "해시 재계산=A");
assert.equal(CHECK_GRADES.signature, "A", "서명 검증=A");
assert.equal(CHECK_GRADES.citation, "B", "인용 대조=B");
assert.equal(CHECK_GRADES.commit, "B", "git 사실 대조=B");
assert.equal(CHECK_GRADES.link, "C", "형식=C");

// number 재계산 → verified · 등급 A · 보류 아님
let ev = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5] }, null);
assert.equal(ev.verified, true);
assert.equal(ev.assuranceGrade, "A");
assert.equal(ev.abstain, false);

// citation → 등급 B
ev = evaluateClaim({ quotedText: "abc" }, "xx abc yy");
assert.equal(ev.verified, true);
assert.equal(ev.assuranceGrade, "B");

// A + B 동시 verified → 최강 등급 A 보고
ev = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5], quotedText: "abc" }, "abc");
assert.equal(ev.assuranceGrade, "A", "최강 등급 A");

// number verified(A) + citation 실패 → failed 지만 실증된 A 보고 · 보류 아님
ev = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5], quotedText: "zzz" }, "abc");
assert.equal(ev.failed, true);
assert.equal(ev.verified, false);
assert.equal(ev.assuranceGrade, "A", "실패 와중에도 실증된 A 보고(과소보고 방지)");
assert.equal(ev.abstain, false);

// 근거 없음 → 보류(abstain) · 등급 null (과대보증 방지)
ev = evaluateClaim({}, null);
assert.equal(ev.failed, false);
assert.equal(ev.verified, false);
assert.equal(ev.abstain, true, "근거 없음 → 명시적 보류");
assert.equal(ev.assuranceGrade, null);

// 결정론: 같은 입력 → 같은 등급·보류
const a = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5] }, null);
const b = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5] }, null);
assert.equal(a.assuranceGrade, b.assuranceGrade);
assert.equal(a.abstain, b.abstain);

console.log("grade.test: OK — A/B/C 등급 + 보류(abstain) 결정론 (재계산>대조>형식·과대보증 방지)");
