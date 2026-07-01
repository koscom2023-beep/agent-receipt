// item 2 — 원장 라인에 reconUnexplained 노출(present-only·hash 제외). 체인 불변 증명.
// `node test/ledger-enrich.test.mjs`.
import assert from "node:assert/strict";
import { ledgerEntryFromReceipt, ledgerEntryHash } from "../dist/ledger.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// 최소 Receipt (ledgerEntryFromReceipt 가 읽는 필드만).
const receipt = (recon) => ({
  timestamp: "2026-07-01T00:00:00.000Z", contractId: "c",
  branch: { current: "main" }, headHash: "abc123", ok: true, contentHash: "sha256:x",
  criticalPaths: [], magnitude: { filesChanged: 2 },
  ...(recon ? { reconciliation: recon } : {}),
});
const mk = (recon) => ledgerEntryFromReceipt(receipt(recon), "r.json", 0, false);

// (a) 미설명 잔차>0 → reconUnexplained 노출
check("unexplained>0 → reconUnexplained 세팅", () => {
  const e = mk({ matched: 1, residuals: [{ path: "b.ts", reason: "unexplained" }], unexplained: 1, capturedNotInGit: 0 });
  assert.equal(e.reconUnexplained, 1);
});
// (b) reconciliation 없음(capture 미사용) → 키 부재
check("reconciliation 없으면 키 부재(present-only)", () => assert.equal("reconUnexplained" in mk(null), false));
// (c) unexplained=0 → 키 부재(잡음 방지)
check("unexplained=0 → 키 부재", () =>
  assert.equal("reconUnexplained" in mk({ matched: 2, residuals: [], unexplained: 0, capturedNotInGit: 0 }), false));

// (d) 🔴 핵심: ledgerEntryHash 는 reconUnexplained 를 무시 → 체인/기존라인 불변
check("reconUnexplained 만 다른 두 엔트리의 entryHash 동일(해시 제외 증명)", () => {
  const withRecon = mk({ matched: 1, residuals: [{ path: "b.ts", reason: "unexplained" }], unexplained: 1, capturedNotInGit: 0 });
  const without = mk(null);
  assert.equal(withRecon.reconUnexplained, 1);
  assert.equal("reconUnexplained" in without, false);
  assert.equal(ledgerEntryHash(withRecon), ledgerEntryHash(without)); // 필드 추가가 체인 해시를 안 바꿈
});

if (fail.length) { console.error(`ledger-enrich: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`ledger-enrich: ${pass} pass ✅`);
