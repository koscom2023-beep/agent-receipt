// P1 v0.18 D4 — cost 진단("왜 비쌌나") 테스트.
// 수용기준(council): ①분해 합계 = costOf 합계(같은 공식·불일치 금지) ②신호는 고정 규칙+발동조건 자백
//   ③판정어 0(낭비/비효율 금지 — DA-2 점수화 뒷문 차단) ④가격 미상 모델 = 제외+카운트(추정 금지).
import assert from "node:assert/strict";
import { diagnoseCost, diagnosisLines } from "../dist/cost.js";
import { costOf } from "../dist/pricing.js";

const mk = (byModel, contextPeak = 0) => ({
  supported: true,
  messages: 10,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  byModel,
  toolCounts: [],
  cost: byModel.reduce((a, m) => a + (m.cost ?? 0), 0),
  hasUnpriced: byModel.some((m) => m.cost == null),
  contextPeak,
  pricingAsOf: "test",
});
const model = (id, tokens) => ({ model: id, tokens, cost: costOf(tokens, id) });

// ① 분해 합계 = costOf 합계(출력 지배 시나리오)
const heavyOut = { input: 10_000, output: 2_000_000, cacheRead: 50_000, cacheCreation: 20_000 };
const s1 = mk([model("claude-opus-4-8", heavyOut)]);
const d1 = diagnoseCost(s1);
assert.ok(d1, "진단 생성");
const compSum = d1.components.reduce((a, c) => a + c.cost, 0);
assert.ok(Math.abs(compSum - costOf(heavyOut, "claude-opus-4-8")) < 1e-9, "구성요소 합 = costOf(같은 공식)");
assert.ok(Math.abs(d1.pricedTotal - compSum) < 1e-9, "pricedTotal 정합");
assert.ok(Math.abs(d1.components.reduce((a, c) => a + c.share, 0) - 1) < 1e-9, "share 합 = 1");
assert.equal(d1.components[0].component, "output", "출력 지배가 1위로 정렬");

// ② 신호: 최대 구성요소 ≥50% + 발동조건 자백
assert.ok(d1.signals.some((x) => x.includes("가장 큰 몫") && x.includes("규칙:")), "50% 신호 + 조건 자백");

// ② 신호: 컨텍스트 정점 ≥200k
const s2 = mk([model("claude-opus-4-8", heavyOut)], 500_000);
const d2 = diagnoseCost(s2);
assert.ok(d2.signals.some((x) => x.includes("컨텍스트 정점") && x.includes("규칙:")), "정점 신호 + 조건 자백");
assert.ok(!d1.signals.some((x) => x.includes("컨텍스트 정점")), "정점 미달이면 신호 없음(고정 규칙)");

// ② 신호: 캐시 생성비 > 읽기비
const churn = { input: 1000, output: 1000, cacheRead: 10_000, cacheCreation: 5_000_000 };
const d3 = diagnoseCost(mk([model("claude-haiku-4-5", churn)]));
assert.ok(d3.signals.some((x) => x.includes("캐시 생성비") && x.includes("규칙:")), "재캐싱 신호");

// ② 신호: 모델 집중 ≥70%
const big = model("claude-opus-4-8", heavyOut);
const small = model("claude-haiku-4-5", { input: 1000, output: 1000, cacheRead: 0, cacheCreation: 0 });
const d4 = diagnoseCost(mk([big, small]));
assert.ok(d4.signals.some((x) => x.includes("모델 집중") && x.includes("claude-opus-4-8")), "모델 집중 신호");

// ③ 판정어 0 — 신호·렌더 어디에도 "낭비/비효율/잘못" 없음(점수화 뒷문 차단)
const allText = [d1, d2, d3, d4].flatMap((d) => [...d.signals, ...diagnosisLines(d)]).join("\n");
assert.ok(!/낭비|비효율|잘못/.test(allText), "판정어 금지");
assert.ok(diagnosisLines(d1)[0].includes("판정 아님"), "헤더에 사실 나열 명시");

// ④ 가격 미상 모델 = 분해 제외 + 카운트(추정 금지)
const d5 = diagnoseCost(mk([big, { model: "mystery-model-9", tokens: churn, cost: null }]));
assert.equal(d5.unpricedModels, 1, "미상 모델 카운트");
assert.ok(Math.abs(d5.pricedTotal - costOf(heavyOut, "claude-opus-4-8")) < 1e-9, "미상 모델은 합에서 제외");
assert.ok(diagnosisLines(d5).some((x) => x.includes("가격 미상")), "제외 사실 표기");

// 미지원/빈 요약 → null / 빈 렌더(출력 불변)
assert.equal(diagnoseCost({ supported: false, byModel: [] }), null);
assert.deepEqual(diagnosisLines(null), []);

console.log("costdiag.test: OK — 분해=costOf 정합·고정 신호(조건 자백)·판정어 0·미상 제외·미지원 불변");
