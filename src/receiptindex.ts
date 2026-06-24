import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listReceipts, parseReceiptJson, criticalTouchedCount, RECEIPTS_REL } from "./receiptStore.js";

// receipts/*.json 의 빠른 조회/외부도구용 요약 인덱스. receipts/ 안이라 verify 가 제외하고,
// 확장자가 .jsonl 이라 listReceipts(.json/.md)도 안 잡는다(receipt 목록 오염 0). 순수 파생물(재생성 가능).
export const INDEX_REL = join(RECEIPTS_REL, "index.jsonl");

export interface IndexEntry {
  file: string;
  timestamp: string;
  ok: boolean | null;
  contractId: string;
  contentHash: string;
  magnitude: number; // magnitude.filesChanged (숫자만)
  criticalTouched: number;
}

export function buildIndex(cwd: string = process.cwd()): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const e of listReceipts(cwd).filter((x) => x.name.endsWith(".json"))) {
    const o = parseReceiptJson(e.abs);
    if (!o) continue;
    out.push({
      file: e.name,
      timestamp: o.timestamp ?? "",
      ok: typeof o.ok === "boolean" ? o.ok : null,
      contractId: o.contractId ?? "",
      contentHash: o.contentHash ?? "",
      magnitude: o.magnitude?.filesChanged ?? 0,
      criticalTouched: criticalTouchedCount(o),
    });
  }
  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  return out;
}

/** `agent-receipt index [--json]` — receipts/*.json 요약을 receipts/index.jsonl 로 재생성(파생 조회용). */
export function runIndex(json: boolean, cwd: string = process.cwd()): never {
  const idx = buildIndex(cwd);
  mkdirSync(join(cwd, RECEIPTS_REL), { recursive: true });
  writeFileSync(join(cwd, INDEX_REL), idx.map((e) => JSON.stringify(e)).join("\n") + (idx.length ? "\n" : ""));
  if (json) {
    process.stdout.write(JSON.stringify(idx, null, 2) + "\n");
    process.exit(0);
  }
  console.log(`index 생성: ${INDEX_REL} (${idx.length} receipts)`);
  console.log("  receipts/ 안이라 verify 가 제외 · receipt 목록에도 안 잡힘. 외부도구/빠른 조회용 메타 요약(파생물).");
  process.exit(0);
}
