// 순수함수 단위테스트 — CLI 를 spawn 하지 않는다(dist/*.js 의 함수를 직접 import). `node test/unit-newlogic.mjs`.
// 대상: redact strong-count · ledger 해시체인 verify · receiptHash 하위호환(schemaVersion 제외 / contentHashes 조건부).
import assert from "node:assert/strict";
import { redactText } from "../dist/redact.js";
import { receiptHash } from "../dist/receipt.js";
import { ledgerEntryHash, verifyLedgerChain } from "../dist/ledger.js";

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

// ── 1. redact strong-count (strict-redact 거부 판단) ──
check("redact: Bearer 는 strong", () => assert.ok(redactText("Authorization: Bearer abc123DEF456ghi").strong >= 1));
check("redact: sk- 토큰은 strong", () => assert.ok(redactText("x=sk-abcdefgh12345678").strong >= 1));
check("redact: API_KEY 이름만이면 strong 아님", () => {
  const r = redactText("API_KEY=plainvalue");
  assert.equal(r.strong, 0);
  assert.ok(r.count >= 1);
});
check("redact: sha256 해시 오탐 없음", () => assert.equal(redactText("contentHash sha256:" + "a".repeat(64)).strong, 0));

// ── 2. ledger 해시체인 ──
const mk = (i, ok) => ({
  timestamp: `2026-06-24T0${i}:00:00Z`,
  contractId: "t",
  branch: "main",
  headHash: `h${i}`,
  ok,
  receiptPath: `r${i}`,
  contentHash: `c${i}`,
  criticalTouchedCount: 0,
  magnitude: i,
  approvalsCount: 0,
  claimMatched: null,
});
const chain = (es) => {
  let prev;
  for (const e of es) {
    e.prevHash = prev;
    e.entryHash = ledgerEntryHash(e);
    prev = e.entryHash;
  }
  return es;
};
check("ledger: 정상 체인 검증 통과", () => {
  const r = verifyLedgerChain(chain([mk(1, true), mk(2, true), mk(3, false)]));
  assert.equal(r.problems.length, 0);
  assert.equal(r.verified, 3);
});
check("ledger: 라인 변조 탐지", () => {
  const es = chain([mk(1, true), mk(2, true), mk(3, false)]);
  es[1].ok = false; // entryHash 재계산 안 함 → 불일치여야
  assert.ok(verifyLedgerChain(es).problems.length >= 1);
});
check("ledger: 중간 라인 삭제 탐지(prevHash)", () => {
  const es = chain([mk(1, true), mk(2, true), mk(3, false)]);
  const cut = [es[0], es[2]];
  assert.ok(verifyLedgerChain(cut).problems.some((p) => p.includes("prevHash")));
});
check("ledger: 레거시 flat 라인 관대(차단 아님)", () => {
  const r = verifyLedgerChain([{ timestamp: "x", ok: true }, { timestamp: "y", ok: false }]);
  assert.equal(r.problems.length, 0);
  assert.equal(r.legacy, 2);
});

// ── 3. receiptHash 하위호환 ──
const base = () => ({
  schemaVersion: "1.0",
  headHash: "abc",
  touched: ["b", "a"],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  magnitude: { filesChanged: 1, added: 1, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  checks: [],
});
check("receiptHash: 결정론적", () => assert.equal(receiptHash(base()), receiptHash(base())));
check("receiptHash: schemaVersion 은 해시에서 제외", () => {
  const b = base();
  b.schemaVersion = "9.9";
  assert.equal(receiptHash(base()), receiptHash(b));
});
check("receiptHash: 빈 contentHashes == 없음(기존 해시 동일)", () => {
  const b = base();
  b.contentHashes = [];
  assert.equal(receiptHash(base()), receiptHash(b));
});
check("receiptHash: contentHashes 있으면 해시 변경", () => {
  const b = base();
  b.contentHashes = [{ path: "a", sha256: "sha256:x", bytes: 1 }];
  assert.notEqual(receiptHash(base()), receiptHash(b));
});

console.log(`unit-newlogic: ${pass} pass, ${fail.length} fail`);
for (const f of fail) console.log(`  ✗ ${f}`);
process.exit(fail.length ? 1 : 0);
