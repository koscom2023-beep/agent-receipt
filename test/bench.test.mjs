// R1 bench 하네스 테스트 — 라벨된 시드셋에서 정밀·재현율·재현성이 결정론으로 재현되는가.
// dist import(빌드 후 실행) · 픽스처는 포터블(인라인 출처·git/IO 프리)이라 어느 머신에서든 동일.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scoreClaim, computeMetrics, verdictOf } from "../dist/bench.js";

const dsPath = fileURLToPath(new URL("../examples/bench/citeseed.json", import.meta.url));
const ds = JSON.parse(readFileSync(dsPath, "utf8"));

// 재현성 반복 4회 — 결정론이면 매회 동일해야 한다.
const scores = ds.claims.map((c) => scoreClaim(c, 4));
const m = computeMetrics(scores);

assert.equal(m.total, 12, "총 12 주장");
assert.equal(m.reproducible, true, "12/12 완전 재현(같은 입력→같은 판정)");
assert.equal(m.identicalClaims, 12);
assert.equal(m.totalEvaluations, 48, "12 주장 × 4 반복");
assert.equal(m.runsPerClaim, 4);

// 혼동행렬(positive = failed = 나쁜 주장 포착)
assert.equal(m.tp, 5, "TP=5 — 환각/오류 5건 모두 포착");
assert.equal(m.fp, 1, "FP=1 — 의역 1건 과잉거절(엄격성의 정직한 대가)");
assert.equal(m.fn, 0, "FN=0 — 놓친 나쁜 주장 없음");
assert.equal(m.tn, 6, "TN=6 — 정합 5 + advisory 1");

assert.ok(Math.abs(m.precision - 5 / 6) < 1e-9, "정밀 = 5/6 ≈ 83.3%");
assert.equal(m.recall, 1, "재현율 100%");
assert.ok(Math.abs(m.f1 - (2 * (5 / 6) * 1) / (5 / 6 + 1)) < 1e-9, "F1 정확");
assert.ok(Math.abs(m.accuracy - 11 / 12) < 1e-9, "정확도 = 11/12 ≈ 91.7%");
assert.deepEqual(m.byVerdict, { verified: 5, failed: 6, advisory: 1 }, "predicted 분포");

// verdictOf 매핑(코어 의미론)
assert.equal(verdictOf({ failed: true, verified: false }), "failed");
assert.equal(verdictOf({ failed: false, verified: true }), "verified");
assert.equal(verdictOf({ failed: false, verified: false }), "advisory");

// 재현성 위반 감지: 손으로 만든 비동일 케이스 → reproducible false(exit 1 게이트가 이걸 잡는다)
const fake = [
  { statement: "a", expected: "failed", predicted: "failed", runs: 3, identical: true, correct: true, fingerprint: "x" },
  { statement: "b", expected: "verified", predicted: "verified", runs: 3, identical: false, correct: true, fingerprint: "y" },
];
assert.equal(computeMetrics(fake).reproducible, false, "비동일 1건 → 재현성 위반 감지");

// 라벨 없는 주장 → 정확도 제외·재현성만
const unlabeled = [scoreClaim({ statement: "x", quotedText: "a", sourceText: "abc" }, 2)];
const um = computeMetrics(unlabeled);
assert.equal(um.labeled, 0, "라벨 없음 → labeled 0");
assert.equal(um.precision, null, "라벨 없으면 정밀 null");
assert.equal(um.reproducible, true);

console.log("bench.test: OK — 재현성 12/12 · TP5/FP1/FN0 · 정밀 83.3% 재현율 100% 정확도 91.7% (정직: 표본내 시드셋)");
