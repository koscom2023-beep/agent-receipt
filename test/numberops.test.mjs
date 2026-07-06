// R7 수식 재계산 강화 — 추가 연산(전부 params-free·단일 정의·결정론)의 정확성.
import assert from "node:assert";
import { evaluateClaim, recompute } from "../dist/evidencekernel.js";

// 직접 재계산
assert.equal(recompute("median", [3, 1, 2]), 2, "median 홀수");
assert.equal(recompute("median", [1, 2, 3, 4]), 2.5, "median 짝수=두 중앙 평균");
assert.equal(recompute("count", [5, 5, 5]), 3);
assert.equal(recompute("abs", [-7]), 7);
assert.equal(recompute("pow", [2, 10]), 1024);
assert.equal(recompute("pow", [2]), null, "pow 인자부족=null");
assert.equal(recompute("mod", [10, 3]), 1);
assert.equal(recompute("mod", [10, 0]), null, "mod 0=null");
assert.ok(Math.abs(recompute("variance", [2, 4, 6]) - 8 / 3) < 1e-9, "모집단 분산");
assert.ok(Math.abs(recompute("stddev", [2, 4, 6]) - Math.sqrt(8 / 3)) < 1e-9, "모집단 표준편차");
assert.equal(recompute("floor", [3.9]), 3);
assert.equal(recompute("ceil", [3.1]), 4);
assert.equal(recompute("round", [2.5]), 3, "half-up");

// evaluateClaim 경유: 일치=verified(등급 A)·불일치=failed
let ev = evaluateClaim({ statedValue: 1024, op: "pow", operands: [2, 10] }, null);
assert.equal(ev.verified, true);
assert.equal(ev.number, "verified");
assert.equal(ev.assuranceGrade, "A", "수치 재계산=등급 A");

ev = evaluateClaim({ statedValue: 999, op: "pow", operands: [2, 10] }, null);
assert.equal(ev.failed, true, "불일치=failed");

ev = evaluateClaim({ statedValue: 2.5, op: "median", operands: [1, 2, 3, 4] }, null);
assert.equal(ev.verified, true, "median 검증");

// eps 허용오차: stddev 근사값도 eps 안이면 verified
ev = evaluateClaim({ statedValue: 1.633, op: "stddev", operands: [2, 4, 6], eps: 1e-3 }, null);
assert.equal(ev.verified, true, "eps 허용오차");

// 결정론
assert.equal(recompute("stddev", [1, 2, 3, 4]), recompute("stddev", [1, 2, 3, 4]));

console.log("numberops.test: OK — median/count/abs/pow/mod/variance/stddev/floor/ceil/round 재계산·결정론(모집단·half-up)");
