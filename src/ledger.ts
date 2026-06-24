import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
  prevHash?: string; // 직전 라인의 entryHash(해시체인). 레거시 flat 라인엔 없음.
  entryHash?: string; // 이 라인의 무결성 해시(entryHash 자신 제외, prevHash 포함) — 변조/삭제/재정렬 탐지.
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

// 해시체인용 entryHash — entryHash 자신은 제외하고 결정론적으로 직렬화(prevHash 포함 → 연결 변조 탐지).
// 새 의존성 0(Node crypto). 같은 내용+같은 prevHash → 같은 entryHash.
function ledgerEntryHash(e: LedgerEntry): string {
  const payload = JSON.stringify({
    timestamp: e.timestamp,
    contractId: e.contractId,
    branch: e.branch,
    headHash: e.headHash,
    ok: e.ok,
    receiptPath: e.receiptPath,
    contentHash: e.contentHash,
    criticalTouchedCount: e.criticalTouchedCount,
    magnitude: e.magnitude,
    approvalsCount: e.approvalsCount,
    claimMatched: e.claimMatched,
    prevHash: e.prevHash ?? null,
  });
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

export function appendLedger(entry: LedgerEntry, cwd: string = process.cwd()): string {
  const p = join(cwd, LEDGER_REL);
  mkdirSync(dirname(p), { recursive: true });
  const prior = existsSync(p) ? readLedger(cwd) : [];
  const last = prior[prior.length - 1];
  const chained: LedgerEntry = { ...entry, prevHash: last?.entryHash };
  chained.entryHash = ledgerEntryHash(chained);
  appendFileSync(p, JSON.stringify(chained) + "\n");
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

/** `agent-receipt ledger verify` — 해시체인 무결성 검사(read-only). 변조/삭제/재정렬 탐지. 레거시(flat) 라인은 '검증불가'(차단 아님). */
export function runLedgerVerify(cwd: string = process.cwd()): never {
  const entries = readLedger(cwd);
  const problems: string[] = [];
  let verified = 0;
  let legacy = 0;
  let prevEntryHash: string | undefined = undefined;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LedgerEntry;
    const n = i + 1;
    if (!e.entryHash) {
      legacy++;
      prevEntryHash = undefined; // 레거시 라인은 체인 연속성 기준점이 못 됨
      continue;
    }
    if (ledgerEntryHash(e) !== e.entryHash) {
      problems.push(`#${n} ${e.timestamp}: entryHash 불일치(라인 내용 변조 가능)`);
    } else {
      verified++;
    }
    if (prevEntryHash !== undefined && (e.prevHash ?? undefined) !== prevEntryHash) {
      problems.push(`#${n} ${e.timestamp}: prevHash 가 직전 라인과 불일치(라인 삭제/재정렬 가능)`);
    }
    prevEntryHash = e.entryHash;
  }
  console.log("");
  console.log(line);
  console.log(`agent-receipt ledger verify — ${entries.length}건 (검증 ${verified} · 레거시 ${legacy} · 문제 ${problems.length})`);
  console.log(line);
  if (problems.length) for (const p of problems) console.log(`  ✗ ${p}`);
  else console.log(legacy ? "  체인 OK ✅ (레거시 flat 라인은 검증 대상 아님)" : "  체인 OK ✅");
  console.log(line);
  console.log("  " + LIMIT_NOTE + " (해시체인은 tamper-evident — 위조불가 아님)");
  console.log("");
  process.exit(problems.length ? 1 : 0);
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
  // 해시체인 재구성(시간순) — rebuild 후에도 ledger verify 가능.
  let prev: string | undefined = undefined;
  for (const e of entries) {
    e.prevHash = prev;
    e.entryHash = ledgerEntryHash(e);
    prev = e.entryHash;
  }
  const p = join(cwd, LEDGER_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  console.log(`ledger 재생성: ${LEDGER_REL} (${entries.length}건, receipts/ 기준)`);
  process.exit(0);
}
