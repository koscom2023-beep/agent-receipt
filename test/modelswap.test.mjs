// R10 모델치환 감사 테스트 — 선언 vs 실제 모델 비용차 정량화·다운그레이드 탐지·가격미상=unpriced.
import assert from "node:assert";
import { auditModelSwap, renderSwapAuditMd } from "../dist/cost.js";

const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 };

// 다운그레이드: 선언 opus($5/$25=$30) → 실제 haiku($1/$5=$6). Δ=+24(과대청구 의심).
let a = auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-haiku-4-5", usage }]);
let r = a.rows[0];
assert.equal(r.swapped, true);
assert.ok(Math.abs(r.declaredCost - 30) < 1e-9, "opus 1M in+out=$30");
assert.ok(Math.abs(r.actualCost - 6) < 1e-9, "haiku=$6");
assert.ok(Math.abs(r.delta - 24) < 1e-9, "Δ=+24");
assert.equal(r.direction, "downgrade");
assert.equal(a.downgrades, 1);

// 업그레이드: 선언 haiku → 실제 opus(Δ<0)
a = auditModelSwap([{ declaredModel: "claude-haiku-4-5", actualModel: "claude-opus-4-8", usage }]);
assert.equal(a.rows[0].direction, "upgrade");
assert.ok(a.rows[0].delta < 0);
assert.equal(a.downgrades, 0);

// 동일 모델 → swap 없음
a = auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-opus-4-8", usage }]);
assert.equal(a.rows[0].swapped, false);
assert.equal(a.rows[0].direction, "same-model");
assert.equal(a.swaps, 0);

// 같은 가격 다른 모델(opus-4-8 vs opus-4-7 동일 가격) → same-price
a = auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-opus-4-7", usage }]);
assert.equal(a.rows[0].direction, "same-price");
assert.equal(a.rows[0].delta, 0);

// 가격 미상 모델 → unpriced(추정 금지·null)
a = auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "gpt-9-turbo", usage }]);
assert.equal(a.rows[0].actualCost, null, "미상=null");
assert.equal(a.rows[0].direction, "unpriced");
assert.equal(a.unpriced, 1);

// 정직 라벨: actual 진실성 미보증
const md = renderSwapAuditMd(auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-haiku-4-5", usage }]));
assert.ok(md.includes("actual 라벨의 진실성은 보증하지 않음"), "정직 경계");

// 결정론
assert.deepEqual(auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-haiku-4-5", usage }]),
                 auditModelSwap([{ declaredModel: "claude-opus-4-8", actualModel: "claude-haiku-4-5", usage }]));

console.log("modelswap.test: OK — 다운그레이드 Δ정량화·업그레이드·same-price·unpriced(추정금지)·정직 라벨·결정론");
