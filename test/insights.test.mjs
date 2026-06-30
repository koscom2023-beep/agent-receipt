// 로컬 분석(9차 council) — insights: 기간대비 추세 + 재발 + watch(서술). 정직: n 작으면 caveat·점수/예측 없음.
// `node test/insights.test.mjs`.
import assert from "node:assert/strict";
import { computeInsights, renderInsightsMd, renderInsightsJson } from "../dist/insights.js";

let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

// ReceiptJson 일부 — computeInsights 가 쓰는 필드만(ok/contractId/timestamp/criticalPaths).
const rc = (ts, ok, contractId, critN = 0) => ({
  ok,
  contractId,
  timestamp: ts,
  criticalPaths: critN ? [{ glob: "x", touched: Array.from({ length: critN }, (_, i) => `p${i}`) }] : [],
});

check("n=0 → 크래시 0·smallSample·빈 결과", () => {
  const r = computeInsights([]);
  assert.equal(r.n, 0);
  assert.equal(r.smallSample, true);
  assert.deepEqual(r.contracts, []);
  assert.deepEqual(r.watch, []);
  assert.ok(renderInsightsMd(r).includes("receipt 없음"));
});

check("n=1 → 크래시 0", () => {
  const r = computeInsights([rc("2026-01-01", true, "A")]);
  assert.equal(r.n, 1);
  assert.equal(r.contracts.length, 1);
});

check("재발 — 같은 contract ≥2 FAIL → recurringFailures + watch", () => {
  const r = computeInsights([rc("t1", false, "A"), rc("t2", false, "A"), rc("t3", true, "B")]);
  assert.ok(r.recurringFailures.some((c) => c.contractId === "A" && c.fail === 2));
  assert.ok(r.watch.some((w) => w.includes("A") && w.toLowerCase().includes("recurring")));
});

check("기간대비 — 이전 PASS·최근 FAIL → FAIL 비율 상승 watch", () => {
  const r = computeInsights([rc("t1", true, "A"), rc("t2", true, "A"), rc("t3", false, "A"), rc("t4", false, "A")]);
  assert.equal(r.failRate.prior, 0);
  assert.equal(r.failRate.recent, 100);
  assert.ok(r.watch.some((w) => w.toLowerCase().includes("fail rate")));
});

check("critical 상승 → watch", () => {
  const r = computeInsights([rc("t1", true, "A", 0), rc("t2", true, "A", 0), rc("t3", true, "A", 2), rc("t4", true, "A", 3)]);
  assert.ok(r.critical.recent > r.critical.prior);
  assert.ok(r.watch.some((w) => w.toLowerCase().includes("critical")));
});

check("n>=6 → smallSample=false", () => {
  const six = Array.from({ length: 6 }, (_, i) => rc(`t${i}`, true, "A"));
  assert.equal(computeInsights(six).smallSample, false);
});

check("정직 — 작은 표본이면 'directional' caveat, 점수/등급 단정 없음", () => {
  const md = renderInsightsMd(computeInsights([rc("t1", false, "A"), rc("t2", true, "B")])).toLowerCase();
  assert.ok(md.includes("small sample") && md.includes("directional"), "small-sample caveat 누락");
  assert.ok(!md.includes("risk score"), "risk score 단정 누출");
  assert.ok(!/grade\s*[a-f]\b/.test(md), "등급(grade A-F) 단정 누출");
});

check("결정론 — 입력 순서 무관(timestamp 정렬)", () => {
  const a = computeInsights([rc("t1", true, "A"), rc("t2", false, "A")]);
  const b = computeInsights([rc("t2", false, "A"), rc("t1", true, "A")]);
  assert.deepEqual(a.failRate, b.failRate);
});

check("json — 유효·contracts/watch 포함", () => {
  const o = JSON.parse(renderInsightsJson(computeInsights([rc("t1", false, "A"), rc("t2", false, "A")])));
  assert.ok(Array.isArray(o.contracts) && Array.isArray(o.watch));
  assert.equal(o.n, 2);
});

if (fail.length) {
  console.error(`insights: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`insights: ${pass} pass, 0 fail`);
