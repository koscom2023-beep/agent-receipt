import { listReceipts, parseReceiptJson, criticalTouchedCount, RECEIPTS_REL } from "./receiptStore.js";

const line = "─".repeat(56);

/**
 * `agent-receipt audit [--json]` — .agent-guard/receipts/ 를 읽어 local audit history 요약.
 * SaaS/dashboard 이전 단계의 로컬 집계(network/remote 없음). 자동 append 안 함 — 조회 전용. exit 0.
 */
export function runAudit(asJson: boolean, cwd: string = process.cwd()): never {
  const entries = listReceipts(cwd);
  const jsons = entries
    .filter((e) => e.name.endsWith(".json"))
    .map((e) => parseReceiptJson(e.abs))
    .filter((o): o is NonNullable<typeof o> => !!o);

  let pass = 0;
  let fail = 0;
  let critical = 0;
  const hashes = new Set<string>();
  for (const o of jsons) {
    if (o.ok === true) pass++;
    else if (o.ok === false) fail++;
    critical += criticalTouchedCount(o);
    if (typeof o.contentHash === "string") hashes.add(o.contentHash);
  }

  const summary = {
    receiptCount: entries.length,
    jsonReceiptCount: jsons.length,
    latest: entries[0]?.rel ?? null,
    pass,
    fail,
    criticalTouched: critical,
    uniqueContentHash: hashes.size,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(summary) + "\n");
    process.exit(0);
  }

  console.log("");
  console.log(line);
  console.log(`agent-receipt audit  (${RECEIPTS_REL} — local history)`);
  console.log(line);
  console.log(`  receipt 수        : ${summary.receiptCount} (json ${summary.jsonReceiptCount})`);
  console.log(`  최신              : ${summary.latest ?? "(없음)"}`);
  console.log(`  PASS / FAIL       : ${pass} / ${fail}`);
  console.log(`  critical touched  : ${critical}`);
  console.log(`  고유 contentHash  : ${hashes.size}`);
  console.log(line);
  if (!entries.length) console.log("  receipt 없음 — 'agent-receipt receipt' 로 생성하세요.");
  else console.log("  상세: agent-receipt receipts   대시보드: agent-receipt dashboard");
  console.log("");
  process.exit(0);
}
