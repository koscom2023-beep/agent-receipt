import { writeFileSync } from "node:fs";
import type { Contract } from "./schema.js";
import { runVerify } from "./checks.js";
import { printReport, toMarkdown } from "./output.js";
import { buildReceipt, toClientMd, toReceiptMd } from "./receipt.js";

export type ReportType = "developer" | "client" | "audit";

/**
 * `agent-receipt report [--type developer|client|audit] [--out <path>]`
 *  - developer(기본): verify 중심 상세 보고서(기존 동작 유지).
 *  - client        : 고객 전달용 축약(내부 경고 최소).
 *  - audit         : 계약/정책/영수증/환경/critical 중심 증거 보고서.
 * 갑작스러운 breaking change 없음 — --type 없으면 기존 developer 와 동일.
 */
export function runReport(
  contract: Contract,
  contractPath: string | undefined,
  type: string | undefined,
  outArg: string | undefined,
): never {
  const t: ReportType = type === "client" ? "client" : type === "audit" ? "audit" : "developer";
  const v = runVerify(contract);
  printReport(v);

  let body: string;
  let suffix: string;
  if (t === "developer") {
    body = toMarkdown(v);
    suffix = "report";
  } else {
    const r = buildReceipt(contract, contractPath);
    body = t === "client" ? toClientMd(r) : toReceiptMd(r);
    suffix = t === "client" ? "client-report" : "audit-report";
  }
  const out = outArg ?? `agent-guard-${suffix}-${contract.id}.md`;
  writeFileSync(out, body, "utf8");
  console.log(`보고서 저장(${t}): ${out}\n`);
  process.exit(v.ok ? 0 : 1);
}
