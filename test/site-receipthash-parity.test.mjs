// 사이트 미러 패리티: site/receipthash.js 가 src/receipt.ts 의 receiptHash 와 바이트 동일한지,
//   적합성 벡터(test/vectors/vectors.json·참조 구현 산출)로 강제한다. 미러가 어긋나면 실패.
// Node 20+ 의 globalThis.crypto(WebCrypto)로 브라우저와 동일 sha256.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");

// IIFE 로드: globalThis.AgentReceiptSeal 부착.
const mirrorSrc = readFileSync(join(root, "site", "receipthash.js"), "utf8");
(0, eval)(mirrorSrc);
const { receiptHash, checkSeal } = globalThis.AgentReceiptSeal;
assert.ok(typeof receiptHash === "function", "미러가 receiptHash 를 노출해야 함");

const vectors = JSON.parse(readFileSync(join(dir, "vectors", "vectors.json"), "utf8"));

let pass = 0;
const fail = [];
for (const v of vectors) {
  try {
    const got = await receiptHash(v.receipt);
    assert.equal(got, v.expectedContentHash, `${v.name}: 미러 != 참조 봉인`);
    const seal = await checkSeal(v.receipt);
    assert.equal(seal.status, "intact", `${v.name}: checkSeal 이 intact 여야 함`);
    pass++;
  } catch (e) {
    fail.push(`${v.name}: ${e.message}`);
  }
}

// 변조 갈래: contentHash 를 깨면 tampered(1.1) / reissue(1.0).
{
  const bad = JSON.parse(JSON.stringify(vectors[0].receipt));
  bad.contentHash = "sha256:" + "0".repeat(64);
  const s = await checkSeal(bad);
  try { assert.equal(s.status, "tampered", "1.1 불일치=tampered"); pass++; } catch (e) { fail.push(`tamper-1.1: ${e.message}`); }
  const old = JSON.parse(JSON.stringify(vectors[0].receipt));
  old.schemaVersion = "1.0"; old.contentHash = "sha256:" + "0".repeat(64);
  const s2 = await checkSeal(old);
  try { assert.equal(s2.status, "reissue", "1.0 불일치=reissue"); pass++; } catch (e) { fail.push(`reissue-1.0: ${e.message}`); }
}

if (fail.length) {
  console.error(`site-receipthash-parity.test: ${pass} pass, ${fail.length} FAIL`);
  for (const f of fail) console.error("  ✗ " + f);
  console.error("  (site/receipthash.js 가 src/receipt.ts receiptHash 와 어긋남 → 미러 수정)");
  process.exit(1);
}
console.log(`site-receipthash-parity.test: OK (${pass}): 브라우저 미러 = 참조 봉인 + 변조/재발행 갈래`);
