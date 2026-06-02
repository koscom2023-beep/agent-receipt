import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import type { Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { resolveSession } from "./session.js";

// AI Work Receipt — verify(상태) + check(명령) 결과 스냅샷. verify --json(14키)와 별개 스키마.
interface Receipt {
  ok: boolean;
  contractId: string;
  title: string | null;
  branch: { current: string; expected: string | null; ok: boolean };
  headHash: string;
  timestamp: string;
  touched: string[];
  staged: string[];
  untracked: string[];
  outOfScope: string[];
  deniedHits: string[];
  violations: string[];
  session: { applied: boolean; reason: string | null; baselineHead: string } | null;
  checks: { name: string; exitCode: number; requiredExit: number; ok: boolean }[];
}

function toReceiptMd(r: Receipt): string {
  const L: string[] = [];
  L.push(`# Agent Receipt: ${r.contractId}`);
  if (r.title) L.push(`> ${r.title}`);
  L.push("");
  L.push(`- ok: **${r.ok ? "PASS ✅" : "FAIL ❌"}**`);
  L.push(`- branch: \`${r.branch.current}\`${r.branch.expected ? ` (expected \`${r.branch.expected}\`)` : ""}`);
  L.push(`- headHash: \`${r.headHash}\``);
  L.push(`- timestamp: ${r.timestamp}`);
  L.push("");
  L.push(`## Changes (touched ${r.touched.length})`);
  for (const f of r.touched) {
    const tag = r.outOfScope.includes(f) ? " — ⚠️ out-of-scope" : r.deniedHits.includes(f) ? " — ⛔ denied" : "";
    L.push(`- \`${f}\`${tag}`);
  }
  if (!r.touched.length) L.push("- (none)");
  L.push("");
  L.push("## Violations");
  if (r.violations.length) for (const v of r.violations) L.push(`- ${v}`);
  else L.push("- (none)");
  L.push("");
  L.push("## Session (baseline)");
  if (!r.session) L.push("- none");
  else L.push(`- applied: ${r.session.applied}${r.session.reason ? ` (${r.session.reason})` : ""}, baselineHead: \`${r.session.baselineHead}\``);
  L.push("");
  L.push("## Checks");
  if (r.checks.length) for (const c of r.checks) L.push(`- ${c.name}: ${c.ok ? "OK" : "✗"} (exit ${c.exitCode}, expected ${c.requiredExit})`);
  else L.push("- (none)");
  L.push("");
  return L.join("\n");
}

/**
 * `agent-receipt receipt [--format json|md] [--out <path>]`
 * verify(상태) + check(명령) 결과를 .agent-guard/receipts/ 아래 파일로 저장(기본 json).
 * 기능 로직(runVerify/runCheck)은 재사용만 한다. exit = ok ? 0 : 1.
 */
export function runReceipt(contract: Contract, format: string | undefined, outArg: string | undefined): never {
  const v = runVerify(contract);
  const chk = runCheck(contract);
  const sess = resolveSession();
  const fmt = format === "md" ? "md" : "json";
  const r: Receipt = {
    ok: v.ok && chk.ok,
    contractId: v.contractId,
    title: v.title ?? null,
    branch: { current: v.branch.current, expected: v.branch.expected ?? null, ok: v.branch.ok },
    headHash: v.headHash,
    timestamp: new Date().toISOString(),
    touched: v.touched,
    staged: v.staged,
    untracked: v.untracked,
    outOfScope: v.outOfScope,
    deniedHits: v.deniedHits,
    violations: v.violations,
    session: sess.session
      ? { applied: sess.applied, reason: sess.reason, baselineHead: sess.session.baselineHead }
      : null,
    checks: chk.commands.map((c) => ({ name: c.name, exitCode: c.exitCode, requiredExit: c.requiredExit, ok: c.ok })),
  };
  const body = fmt === "md" ? toReceiptMd(r) : JSON.stringify(r, null, 2) + "\n";
  const stamp = r.timestamp.replace(/[:.]/g, "-");
  const rel = outArg ?? join(".agent-guard", "receipts", `receipt-${stamp}.${fmt}`);
  const out = isAbsolute(rel) ? rel : join(process.cwd(), rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  console.log(`receipt 저장: ${rel} (ok=${r.ok})`);
  process.exit(r.ok ? 0 : 1);
}
