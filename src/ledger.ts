import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt } from "./receipt.js";
import {
  listReceipts,
  parseReceiptJson,
  criticalTouchedCount,
  approvalsCountFor,
  RECEIPTS_REL,
} from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";

// ── 로컬 원장(append-only) ──
// .agent-guard/ledger.jsonl — 1줄 = 1영수증 요약(메타만). "이 레포에서 AI가 뭘 했나"를 grep 로 답한다.
// 원칙: 내용/diff/값 금지(경로·해시·메타만). 자동 append 기본 OFF(done/audit-pack --ledger 또는 rebuild).
//       SaaS/대시보드/웹 렌더 금지 — flat 파일까지만. verify 의 tool-output 제외 대상(session.ts).

export const LEDGER_REL = join(".agent-guard", "ledger.jsonl");

export interface LedgerEntry {
  timestamp: string;
  contractId: string;
  branch: string;
  headHash: string;
  ok: boolean;
  receiptPath: string;
  contentHash: string;
  criticalTouchedCount: number;
  magnitude: number; // magnitude.filesChanged (숫자만 — 점수 아님)
  approvalsCount: number;
  claimMatched: boolean | null; // claims 미실행 시 null
}

export function ledgerEntryFromReceipt(
  r: Receipt,
  receiptRel: string,
  approvalsCount: number,
  claimMatched: boolean | null,
): LedgerEntry {
  return {
    timestamp: r.timestamp,
    contractId: r.contractId,
    branch: r.branch.current,
    headHash: r.headHash,
    ok: r.ok,
    receiptPath: receiptRel,
    contentHash: r.contentHash,
    criticalTouchedCount: r.criticalPaths.reduce((n, c) => n + c.touched.length, 0),
    magnitude: r.magnitude.filesChanged,
    approvalsCount,
    claimMatched,
  };
}

export function appendLedger(entry: LedgerEntry, cwd: string = process.cwd()): string {
  const p = join(cwd, LEDGER_REL);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n");
  return LEDGER_REL;
}

function readLedger(cwd: string): LedgerEntry[] {
  const p = join(cwd, LEDGER_REL);
  if (!existsSync(p)) return [];
  const out: LedgerEntry[] = [];
  for (const ln of readFileSync(p, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln) as LedgerEntry);
    } catch {
      /* 손상 라인은 건너뜀(원장은 best-effort 읽기) */
    }
  }
  return out;
}

const line = "─".repeat(56);

/** `agent-receipt ledger [--json]` — 원장 조회(read-only). */
export function runLedger(json: boolean, cwd: string = process.cwd()): never {
  const entries = readLedger(cwd);
  if (json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log(`agent-receipt ledger  (${LEDGER_REL}) — ${entries.length}건`);
  console.log(line);
  if (!entries.length) {
    console.log("  비어 있음 — `done --ledger` / `audit-pack --ledger` 로 적립하거나 `ledger rebuild`.");
  } else {
    for (const e of entries) {
      const crit = e.criticalTouchedCount ? ` crit:${e.criticalTouchedCount}` : "";
      const ap = e.approvalsCount ? ` ✓approved` : "";
      const cm = e.claimMatched === null ? "" : e.claimMatched ? " claim✓" : " claim✗";
      console.log(`  ${e.timestamp}  ${e.ok ? "PASS" : "FAIL"}  ${e.contractId}  ${e.branch}  files:${e.magnitude}${crit}${ap}${cm}`);
      console.log(`      ${e.headHash}  ${e.contentHash}  ${e.receiptPath}`);
    }
  }
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}

/** `agent-receipt ledger rebuild` — receipts/ 의 json receipt 들을 읽어 원장을 재생성(덮어씀). */
export function runLedgerRebuild(cwd: string = process.cwd()): never {
  const receipts = listReceipts(cwd).filter((e) => e.name.endsWith(".json"));
  const entries: LedgerEntry[] = [];
  for (const e of receipts) {
    const o = parseReceiptJson(e.abs);
    if (!o || typeof o.contentHash !== "string") continue;
    entries.push({
      timestamp: o.timestamp ?? "",
      contractId: o.contractId ?? "",
      branch: o.branch?.current ?? "",
      headHash: o.headHash ?? "",
      ok: o.ok === true,
      receiptPath: join(RECEIPTS_REL, e.name),
      contentHash: o.contentHash,
      criticalTouchedCount: criticalTouchedCount(o),
      magnitude: o.magnitude?.filesChanged ?? 0,
      approvalsCount: approvalsCountFor(e.abs),
      claimMatched: null, // rebuild 시점엔 claim 대조 결과를 알 수 없음
    });
  }
  // 시간 오름차순(파일명=timestamp 기반이라 안정 정렬)
  entries.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const p = join(cwd, LEDGER_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  console.log(`ledger 재생성: ${LEDGER_REL} (${entries.length}건, receipts/ 기준)`);
  process.exit(0);
}
