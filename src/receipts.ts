import { readFileSync } from "node:fs";
import {
  RECEIPTS_REL,
  receiptsDirAbs,
  listReceipts,
  parseReceiptJson,
  criticalTouchedCount,
  type ReceiptEntry,
  type ReceiptJson,
} from "./receiptStore.js";

const line = "─".repeat(56);

function okStr(ok: boolean | undefined): string {
  return ok === true ? "PASS ✅" : ok === false ? "FAIL ❌" : "?";
}

function listLine(e: ReceiptEntry): string {
  if (e.name.endsWith(".json")) {
    const o = parseReceiptJson(e.abs);
    if (o) return `${e.name}  [${okStr(o.ok)}] ${o.contractId ?? "?"}  ${o.timestamp ?? "?"}  critical:${criticalTouchedCount(o)}`;
    return `${e.name}  (json 파싱 실패)`;
  }
  return `${e.name}  (md — 내용은 --cat)`;
}

export type ReceiptsMode = "list" | "latest" | "cat" | "dir";

/**
 * `agent-receipt receipts [--latest|--cat|--dir]`
 * .agent-guard/receipts/ 아래 저장된 receipt 를 찾는다(read-only). 계약/ git 불필요.
 *  - (없음) 최근 10개 목록 / --latest 최신 요약 / --cat 최신 내용 / --dir 디렉터리 경로
 * receipt 가 없는 건 오류가 아님 → 더 안전한 exit 0 + 생성 안내.
 */
export function runReceipts(mode: ReceiptsMode, cwd: string = process.cwd()): never {
  if (mode === "dir") {
    console.log(receiptsDirAbs(cwd)); // 스크립트용 — 절대경로 그대로.
    process.exit(0);
  }

  const entries = listReceipts(cwd);

  if (!entries.length) {
    console.log("");
    console.log(`receipt 없음 (${RECEIPTS_REL} 비어있음/없음).`);
    console.log("  → agent-receipt receipt   (verify+check 결과를 저장)");
    console.log("");
    process.exit(0); // read-only 조회 — 없음은 실패 아님(exit 0).
  }

  if (mode === "cat") {
    process.stdout.write(readFileSync(entries[0].abs, "utf8")); // 최신 내용 그대로.
    process.exit(0);
  }

  if (mode === "latest") {
    const e = entries[0];
    console.log("");
    console.log(line);
    console.log("agent-receipt receipts --latest");
    console.log(line);
    console.log(`  파일        : ${e.rel}`);
    if (e.name.endsWith(".json")) {
      const o: ReceiptJson | null = parseReceiptJson(e.abs);
      if (o) {
        console.log(`  ok          : ${okStr(o.ok)}`);
        console.log(`  contractId  : ${o.contractId ?? "?"}`);
        console.log(`  timestamp   : ${o.timestamp ?? "?"}`);
        console.log(`  contentHash : ${o.contentHash ?? "?"}`);
        if (o.magnitude) console.log(`  magnitude   : files ${o.magnitude.filesChanged ?? 0}, +${o.magnitude.added ?? 0}/-${o.magnitude.deleted ?? 0}, new ${o.magnitude.newFiles ?? 0}`);
        console.log(`  critical    : ${criticalTouchedCount(o)} touched`);
      } else {
        console.log("  (json 파싱 실패 — 내용 직접 확인: agent-receipt receipts --cat)");
      }
    } else {
      console.log("  (md receipt — 내용은 agent-receipt receipts --cat)");
    }
    console.log(line);
    console.log("  내용: agent-receipt receipts --cat   대조: agent-receipt claims --file <claim.json>");
    console.log("");
    process.exit(0);
  }

  // mode === "list"
  console.log("");
  console.log(line);
  console.log(`agent-receipt receipts  (${RECEIPTS_REL}, 총 ${entries.length}개 — 최신순)`);
  console.log(line);
  for (const e of entries.slice(0, 10)) console.log(`  ${listLine(e)}`);
  if (entries.length > 10) console.log(`  … 외 ${entries.length - 10}개`);
  console.log(line);
  console.log("  최신 요약: --latest   최신 내용: --cat   디렉터리: --dir");
  console.log("");
  process.exit(0);
}
