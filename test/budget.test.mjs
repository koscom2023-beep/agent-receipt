// 계약 변경량 예산(budget) — council 2026-07-03 증분2 수락 기준.
// 관찰 warn 전용(차단 아님·판정/--json 불변) · 미설정=byte-invariant. `node test/budget.test.mjs`.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetLines } from "../dist/output.js";
import { loadContract } from "../dist/schema.js";

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

const mkContract = (body) => {
  const d = mkdtempSync(join(tmpdir(), "ar-budget-"));
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  const p = join(d, ".agent-guard", "contract.yaml");
  writeFileSync(p, body);
  return loadContract(p);
};

const BASE = `id: b1\nscope:\n  allowed_paths: ["src/**"]\n  denied_paths: []\n`;

check("budget 미설정 → 빈 배열(기존 출력 byte-invariant)", () => {
  const c = mkContract(BASE);
  assert.equal(budgetLines({ touched: ["a", "b"], untracked: [] }, c).length, 0);
  assert.equal(budgetLines({ touched: [], untracked: [] }, undefined).length, 0);
});

check("초과 → ⚠️ warn (차단 아님 문구 포함)", () => {
  const c = mkContract(BASE + `budget:\n  max_touched_files: 3\n`);
  const L = budgetLines({ touched: ["a", "b", "c", "d", "e"], untracked: [] }, c);
  assert.equal(L.length, 1);
  assert.ok(L[0].includes("⚠️"));
  assert.ok(L[0].includes("5개 > 예산 3개"));
  assert.ok(L[0].includes("차단 아님"));
});

check("이내 → ✓ 표시", () => {
  const c = mkContract(BASE + `budget:\n  max_touched_files: 8\n  max_new_files: 2\n`);
  const L = budgetLines({ touched: ["a"], untracked: ["n1"] }, c);
  assert.equal(L.length, 2);
  assert.ok(L[0].startsWith("✓"));
  assert.ok(L[1].startsWith("✓"));
});

check("새 파일 예산 초과 → ⚠️", () => {
  const c = mkContract(BASE + `budget:\n  max_new_files: 1\n`);
  const L = budgetLines({ touched: [], untracked: ["n1", "n2", "n3"] }, c);
  assert.equal(L.length, 1);
  assert.ok(L[0].includes("3개 > 예산 1개"));
});

check("스키마: 0/음수 예산은 로딩 거부(positive int)", () => {
  assert.throws(() => mkContract(BASE + `budget:\n  max_touched_files: 0\n`));
  assert.throws(() => mkContract(BASE + `budget:\n  max_new_files: -2\n`));
});

check("스키마: budget 없는 기존 계약은 그대로 로드(하위호환)", () => {
  const c = mkContract(BASE);
  assert.equal(c.budget, undefined);
});

console.log(`budget.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
