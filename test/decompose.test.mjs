// R6 주장 분해 테스트 — 복합 주장 → 원자 sub-claim(등급·positive·정규화 verdict)·결정론.
import assert from "node:assert";
import { evaluateClaim, decomposeClaim, CHECK_GRADES } from "../dist/evidencekernel.js";

// 복합 주장: number(A) + citation(B) 둘 다 verified → sub-claim 2개
let ev = evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5], quotedText: "abc" }, "abc");
let subs = decomposeClaim(ev);
assert.equal(subs.length, 2, "활성 검사 2개");
const byKind = Object.fromEntries(subs.map((s) => [s.kind, s]));
assert.equal(byKind.number.verdict, "verified");
assert.equal(byKind.number.grade, "A");
assert.equal(byKind.number.grade, CHECK_GRADES.number);
assert.equal(byKind.citation.verdict, "verified");
assert.equal(byKind.citation.grade, "B");

// 혼합: number 실패 + citation 통과 → assertion 단위로 갈림
ev = evaluateClaim({ statedValue: 11, op: "sum", operands: [2, 3, 5], quotedText: "abc" }, "abc");
const m2 = Object.fromEntries(decomposeClaim(ev).map((s) => [s.kind, s.verdict]));
assert.equal(m2.number, "failed");
assert.equal(m2.citation, "verified");

// 근거 없음 → 분해 0(assertion 없음)
assert.equal(decomposeClaim(evaluateClaim({}, null)).length, 0);

// positive 플래그: link=well-formedness(positive false)
ev = evaluateClaim({ link: "https://example.com" }, null);
const linkSub = decomposeClaim(ev).find((s) => s.kind === "link");
assert.ok(linkSub, "link 활성");
assert.equal(linkSub.positive, false, "link=positive false");

// 모든 sub-claim 의 grade 는 CHECK_GRADES 와 일치(SSOT)
for (const s of decomposeClaim(evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5], quotedText: "abc" }, "abc"))) {
  assert.equal(s.grade, CHECK_GRADES[s.kind], `등급 SSOT: ${s.kind}`);
}

// 결정론
assert.deepEqual(
  decomposeClaim(evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5] }, null)),
  decomposeClaim(evaluateClaim({ statedValue: 10, op: "sum", operands: [2, 3, 5] }, null)),
);

console.log("decompose.test: OK — 복합 주장 → 원자 sub-claim(등급·positive·verdict)·결정론");
