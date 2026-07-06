// 백로그: range 검사종 — 수치 상·하한(포함) 검증·등급 B·number 충돌無·A+B 결합.
import assert from "node:assert";
import { evaluateClaim, rangeStatus } from "../dist/evidencekernel.js";

// 순수 rangeStatus
assert.equal(rangeStatus(5, 1, 10), "verified");
assert.equal(rangeStatus(0, 1, 10), "mismatch", "하한 미만");
assert.equal(rangeStatus(11, 1, 10), "mismatch", "상한 초과");
assert.equal(rangeStatus(5, 5, 5), "verified", "경계 포함");
assert.equal(rangeStatus(5, null, 10), "verified", "상한만");
assert.equal(rangeStatus(5, 1, null), "verified", "하한만");
assert.equal(rangeStatus(5, null, null), "no-basis", "경계 없음");

// evaluateClaim 경유
let ev = evaluateClaim({ statedValue: 7, statedMin: 1, statedMax: 10 }, null);
assert.equal(ev.range, "verified");
assert.equal(ev.verified, true);
assert.equal(ev.assuranceGrade, "B", "range=등급 B");
assert.equal(ev.number, "no-basis", "number 무해 no-basis(충돌 없음)");
assert.equal(ev.abstain, false);

ev = evaluateClaim({ statedValue: 99, statedMin: 1, statedMax: 10 }, null);
assert.equal(ev.range, "mismatch");
assert.equal(ev.failed, true);
assert.ok(ev.evidence.range && ev.evidence.range.expected.includes("[1, 10]"), "range evidence 경계 표기");

// 문자열 입력(콤마 포함)도 파싱
ev = evaluateClaim({ statedValue: "1,500", statedMin: "1,000", statedMax: "2,000" }, null);
assert.equal(ev.range, "verified", "콤마 수치 파싱");

// range + number 결합: op 재계산값이 범위 안(A+B) → 최강 등급 A
ev = evaluateClaim({ statedValue: 10, op: "sum", operands: [3, 3, 4], statedMin: 5, statedMax: 20 }, null);
assert.equal(ev.number, "verified", "재계산 A");
assert.equal(ev.range, "verified", "범위 B");
assert.equal(ev.assuranceGrade, "A", "최강 A");

// 결정론
assert.equal(rangeStatus(5, 1, 10), rangeStatus(5, 1, 10));

console.log("range.test: OK — 상·하한(포함)·경계·number 충돌無·A+B 결합·evidence·결정론");
