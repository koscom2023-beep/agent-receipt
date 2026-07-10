// 적합성 테스트벡터 검증: test/vectors/vectors.json 의 각 (receipt, expectedContentHash) 쌍에 대해
//   receiptHash(receipt) 가 expectedContentHash 와 receipt.contentHash 둘 다와 일치하는지 확인.
// 역할: ① 봉인(receiptHash) 회귀 가드(산식이 바뀌면 벡터가 깨져 재생성 강제) ② 제3자 적합성 참조.
// 재생성: `node test/vectors/generate.mjs`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { receiptHash } from "../dist/receipt.js";

const dir = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(dir, "vectors", "vectors.json"), "utf8"));

let pass = 0;
const fail = [];
assert.ok(Array.isArray(vectors) && vectors.length >= 5, "벡터가 5개 이상이어야 함");

for (const v of vectors) {
  try {
    const recomputed = receiptHash(v.receipt);
    assert.equal(recomputed, v.expectedContentHash, `${v.name}: 재계산 != expectedContentHash`);
    assert.equal(recomputed, v.receipt.contentHash, `${v.name}: 재계산 != receipt.contentHash(내장)`);
    // 봉인 커버리지 스모크: ok 를 뒤집으면 반드시 해시가 바뀐다(판정 봉인 실증).
    const flipped = { ...v.receipt, ok: !v.receipt.ok };
    assert.notEqual(receiptHash(flipped), v.expectedContentHash, `${v.name}: ok 위변조가 봉인을 안 바꿈`);
    pass++;
  } catch (e) {
    fail.push(`${v.name}: ${e.message}`);
  }
}

if (fail.length) {
  console.error(`receipt-vectors.test: ${pass} pass, ${fail.length} FAIL`);
  for (const f of fail) console.error("  ✗ " + f);
  console.error("  (벡터가 봉인 산식과 어긋남 → 의도된 변경이면 `node test/vectors/generate.mjs` 재생성)");
  process.exit(1);
}
console.log(`receipt-vectors.test: OK (${pass}): 적합성 벡터 재계산 일치 + ok 위변조가 봉인 파괴`);
