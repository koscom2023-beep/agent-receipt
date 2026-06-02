import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import type { Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { resolveSession } from "./session.js";
import { collectMagnitude, criticalPathHits, touchedFull, type Magnitude, type CriticalPath } from "./evidence.js";

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
  magnitude: Magnitude; // 변경 규모(full working tree 기준 — baseline-relative 아님)
  criticalPaths: CriticalPath[]; // 고위험 경로 touched/untouched (코드 상수 — 계약 필드 아님)
  contentHash: string; // sha256 무결성 해시(timestamp 제외 — 아래 receiptHash 입력 참고)
}

// 키를 정렬해 직렬화(객체 순서 비의존). 배열은 호출부에서 미리 정렬해 넣는다.
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce((o, k) => {
            o[k] = (val as Record<string, unknown>)[k];
            return o;
          }, {} as Record<string, unknown>)
      : val,
  );
}

// Receipt Integrity — Node 내장 crypto(sha256)만 사용(새 의존성 없음). 입력은 결정론적 git 실측:
// headHash + touched/staged/untracked/outOfScope/deniedHits(정렬) + magnitude + criticalTouched + checks.
// timestamp 는 의도적으로 제외(시간마다 바뀌므로) → 같은 git 상태면 같은 hash. ed25519 서명은 백로그(미구현).
function receiptHash(r: Receipt): string {
  const payload = {
    headHash: r.headHash,
    touched: [...r.touched].sort(),
    staged: [...r.staged].sort(),
    untracked: [...r.untracked].sort(),
    outOfScope: [...r.outOfScope].sort(),
    deniedHits: [...r.deniedHits].sort(),
    magnitude: r.magnitude,
    criticalTouched: r.criticalPaths.flatMap((c) => c.touched).sort(),
    checks: r.checks.map((c) => `${c.name}:${c.exitCode}:${c.requiredExit}:${c.ok}`).sort(),
  };
  return "sha256:" + createHash("sha256").update(stableStringify(payload)).digest("hex");
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
  L.push("## Magnitude (full working tree vs HEAD — git numstat)");
  L.push(`- files changed: ${r.magnitude.filesChanged}, +${r.magnitude.added} / -${r.magnitude.deleted} lines, new files: ${r.magnitude.newFiles}`);
  L.push("");
  L.push("## Critical paths");
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  if (hit.length) for (const c of hit) L.push(`- ⚠️ \`${c.glob}\`: ${c.touched.join(", ")}`);
  else L.push("- (none touched)");
  L.push("");
  L.push("## Integrity");
  L.push(`- contentHash: \`${r.contentHash}\``);
  L.push("");
  return L.join("\n");
}

// 고객/외주 전달용 Markdown — 내부 violation 상세는 빼고 결과/규모/무결성 요약만.
// receipt JSON 스키마는 그대로(렌더 변종일 뿐). 같은 r 을 입력으로 받는다.
function toClientMd(r: Receipt): string {
  const L: string[] = [];
  L.push(`# AI Work Receipt — ${r.contractId}`);
  if (r.title) L.push(`> ${r.title}`);
  L.push("");
  L.push(`- Result: **${r.ok ? "PASS ✅" : "FAIL ❌"}**`);
  L.push(`- Branch: \`${r.branch.current}\`${r.branch.expected ? ` (expected \`${r.branch.expected}\`)` : ""}`);
  L.push(`- Commit (HEAD): \`${r.headHash}\``);
  L.push(`- Files changed: ${r.touched.length}`);
  L.push(`- Magnitude: ${r.magnitude.filesChanged} files, +${r.magnitude.added} / -${r.magnitude.deleted} lines, ${r.magnitude.newFiles} new`);
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  L.push(hit.length ? `- Critical paths touched: ${hit.map((c) => c.glob).join(", ")}` : "- Critical paths: none touched");
  L.push(`- Checks: ${r.checks.length ? r.checks.map((c) => `${c.name} ${c.ok ? "OK" : "✗"}`).join(", ") : "none"}`);
  L.push(`- Integrity (contentHash): \`${r.contentHash}\``);
  L.push(`- Generated at: ${r.timestamp}`);
  L.push("");
  L.push("## Reviewer note");
  L.push("> _(reviewer fills in)_");
  L.push("");
  return L.join("\n");
}

/**
 * `agent-receipt receipt [--format json|md|client-md] [--out <path>]`
 * verify(상태) + check(명령) 결과를 .agent-guard/receipts/ 아래 파일로 저장(기본 json).
 * 기능 로직(runVerify/runCheck)은 재사용만 한다. exit = ok ? 0 : 1.
 */
export function runReceipt(contract: Contract, format: string | undefined, outArg: string | undefined): never {
  const v = runVerify(contract);
  const chk = runCheck(contract);
  const sess = resolveSession();
  const fmt = format === "md" ? "md" : format === "client-md" ? "client-md" : "json";
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
    magnitude: collectMagnitude(),
    criticalPaths: criticalPathHits(touchedFull()),
    contentHash: "",
  };
  r.contentHash = receiptHash(r); // 나머지 필드 확정 후 봉인(자기 자신은 입력에서 제외).
  const body = fmt === "md" ? toReceiptMd(r) : fmt === "client-md" ? toClientMd(r) : JSON.stringify(r, null, 2) + "\n";
  const stamp = r.timestamp.replace(/[:.]/g, "-");
  const ext = fmt === "json" ? "json" : "md"; // client-md 도 .md 로 저장(json 외엔 md).
  const rel = outArg ?? join(".agent-guard", "receipts", `receipt-${stamp}.${ext}`);
  const out = isAbsolute(rel) ? rel : join(process.cwd(), rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  console.log(`receipt 저장: ${rel} (ok=${r.ok})`);
  // verify 는 .agent-guard/receipts/ 만 자동 제외한다. 그 밖에 저장하면 다음 verify 가 이 파일을
  // 변경(outOfScope/untracked)으로 잡을 수 있으므로 기본 위치 사용을 권한다(자동 revert 아님 — 안내만).
  const rl = relative(join(process.cwd(), ".agent-guard", "receipts"), out);
  if (rl.startsWith("..") || isAbsolute(rl)) {
    console.log("  참고: 기본 위치(.agent-guard/receipts/) 밖이라 다음 verify 가 이 파일을 변경으로 잡을 수 있습니다. 기본 위치 권장.");
  }
  console.log("  → 조회: `agent-receipt receipts` (목록) / `--latest` / `--cat`");
  process.exit(r.ok ? 0 : 1);
}
