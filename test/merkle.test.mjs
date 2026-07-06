// R3 Merkle 투명로그(RFC6962) 테스트 — 도메인분리 벡터 + 포함/일관성 라운드트립(모든 m≤n) + 변조/포크 음성.
import assert from "node:assert";
import {
  leafHash, nodeHash, merkleRoot, merkleRootHex,
  inclusionProof, verifyInclusion, consistencyProof, verifyConsistency,
} from "../dist/merkle.js";

// ── 도메인 분리 고정 벡터(RFC6962 §2.1) ──
// leaf 빈문자열 = SHA256(0x00), 빈 트리 = SHA256("")
assert.equal(leafHash("").toString("hex"), "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d", "leafHash('')=SHA256(0x00)");
assert.equal(merkleRootHex([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "empty tree=SHA256()");
// leaf ≠ node 도메인 분리(같은 바이트라도 태그가 달라 다른 해시)
assert.notEqual(leafHash("x").toString("hex"), nodeHash(Buffer.from("x"), Buffer.alloc(0)).toString("hex"));
// n=1 root = leafHash
assert.equal(merkleRootHex(["d0"]), leafHash("d0").toString("hex"));
// n=2 root = nodeHash(leaf0, leaf1)
assert.equal(merkleRootHex(["a", "b"]), nodeHash(leafHash("a"), leafHash("b")).toString("hex"));

const leaves = Array.from({ length: 9 }, (_, i) => `d${i}`);

// ── 포함증명: 모든 크기·모든 index 라운드트립 + 변조 음성 ──
for (let n = 1; n <= 9; n++) {
  const sub = leaves.slice(0, n);
  const root = merkleRoot(sub);
  for (let i = 0; i < n; i++) {
    const proof = inclusionProof(i, sub);
    assert.equal(verifyInclusion(leafHash(sub[i]), i, n, proof, root), true, `포함 n=${n} i=${i}`);
    // 변조: root 1바이트 변경 → false
    const bad = Buffer.from(root); bad[0] ^= 0xff;
    assert.equal(verifyInclusion(leafHash(sub[i]), i, n, proof, bad), false, `변조root n=${n} i=${i}`);
    // 엉뚱한 leaf → false
    assert.equal(verifyInclusion(leafHash("WRONG"), i, n, proof, root), false, `엉뚱leaf n=${n} i=${i}`);
  }
}

// ── 일관성증명: 모든 m≤n 라운드트립 + 변조 음성 ──
for (let n = 1; n <= 9; n++) {
  const sub = leaves.slice(0, n);
  const newRoot = merkleRoot(sub);
  for (let m = 1; m <= n; m++) {
    const oldRoot = merkleRoot(sub.slice(0, m));
    const proof = consistencyProof(m, sub);
    assert.equal(verifyConsistency(m, n, proof, oldRoot, newRoot), true, `일관성 m=${m} n=${n}`);
    if (m < n) {
      const badNew = Buffer.from(newRoot); badNew[0] ^= 0xff;
      assert.equal(verifyConsistency(m, n, proof, oldRoot, badNew), false, `변조newRoot m=${m} n=${n}`);
    }
  }
}

// ── 포크 탐지(money test): 게시된 old-root 를 두고 로그의 과거 leaf 를 몰래 개찬하면 일관성 검증 실패 ──
{
  const honest = ["d0", "d1", "d2", "d3", "d4"];
  const m = 3;
  const publishedOldRoot = merkleRoot(honest.slice(0, m)); // 감사인이 예전에 받아둔 root
  // 포크: 과거 leaf(d1)를 몰래 바꾼 대체 히스토리
  const forked = ["d0", "TAMPERED", "d2", "d3", "d4"];
  const forkedNewRoot = merkleRoot(forked);
  const forkedProof = consistencyProof(m, forked);
  // 포크된 로그는 "예전에 게시한 old-root" 와 일관될 수 없다 → false = 개찬 탐지
  assert.equal(verifyConsistency(m, forked.length, forkedProof, publishedOldRoot, forkedNewRoot), false, "포크 탐지");
  // 정직한 확장은 통과
  const honestNewRoot = merkleRoot(honest);
  const honestProof = consistencyProof(m, honest);
  assert.equal(verifyConsistency(m, honest.length, honestProof, publishedOldRoot, honestNewRoot), true, "정직 확장 통과");
}

// ── 결정론: 같은 leaves → 같은 root ──
assert.equal(merkleRootHex(leaves), merkleRootHex(leaves.slice()));

console.log("merkle.test: OK — RFC6962 도메인분리·포함/일관성 라운드트립(n≤9 전수)·포크 탐지 음성");
