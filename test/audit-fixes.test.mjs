// 13차 council 감사 fix — extractRekorUuid(409 오파싱 가드)·loadSavedReceipt(공용 로더 성공경로).
// `node test/audit-fixes.test.mjs`. (로더 실패경로=process.exit(2)는 in-process 테스트 불가 → e2e 로 검증.)
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractRekorUuid } from "../dist/anchor.js";
import { loadSavedReceipt } from "../dist/receiptStore.js";

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

const UUID = "a3f9e1b2c4d5e6f70123456789abcdef0123456789abcdef0123456789abcdef";

// ── anchor 409 가드(#6) ──
check("201 엔트리맵 → 키=UUID + logIndex", () => {
  const r = extractRekorUuid(JSON.stringify({ [UUID]: { logIndex: 42 } }));
  assert.equal(r.uuid, UUID);
  assert.equal(r.logIndex, 42);
});
check("409 already-exists 메시지 → 메시지에서 UUID 추출(logIndex null)", () => {
  const r = extractRekorUuid(JSON.stringify({ code: 409, message: `entry already exists: ${UUID}` }), 409);
  assert.equal(r.uuid, UUID);
  assert.equal(r.logIndex, null);
});
check("UUID 없는 에러바디/비-JSON → null(가짜 sidecar 금지)", () => {
  assert.equal(extractRekorUuid(JSON.stringify({ code: 500, message: "internal error" })), null);
  assert.equal(extractRekorUuid(JSON.stringify({ code: 409 })), null);
  assert.equal(extractRekorUuid("not json at all"), null);
});

// ── 공용 로더(#2/#5/#7/#9) 성공경로 ──
const cwd = join(tmpdir(), "agent-receipt-loader-test");
rmSync(cwd, { recursive: true, force: true });
const recDir = join(cwd, ".agent-guard", "receipts");
mkdirSync(recDir, { recursive: true });
const full = {
  ok: true,
  contractId: "x",
  branch: { current: "main", expected: null, ok: true },
  headHash: "abc1234",
  checks: [],
  criticalPaths: [],
  touched: ["a.ts"],
  staged: [],
  untracked: [],
  deniedHits: [],
  outOfScope: [],
  magnitude: { filesChanged: 1, added: 1, deleted: 0, newFiles: 0 },
  contentHash: "sha256:y",
  timestamp: "2026-01-01T00-00-00.000Z",
};
const recAbs = join(recDir, "2026-01-01T00-00-00.000Z.json");
writeFileSync(recAbs, JSON.stringify(full));

check("loadSavedReceipt — explicit 경로 정상 적재(abs+receipt)", () => {
  const { abs, receipt } = loadSavedReceipt(recAbs, "test", cwd);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.contractId, "x");
  assert.ok(abs.endsWith(".json"));
});
check("loadSavedReceipt — 인자 없으면 최신 영수증", () => {
  assert.equal(loadSavedReceipt(undefined, "test", cwd).receipt.contractId, "x");
});
rmSync(cwd, { recursive: true, force: true });

if (fail.length) {
  console.error(`audit-fixes: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`audit-fixes: ${pass} pass, 0 fail`);
