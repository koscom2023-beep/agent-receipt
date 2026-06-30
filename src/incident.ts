import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  listReceipts,
  parseReceiptJson,
  criticalTouchedCount,
  hasApproval,
  hasSignature,
} from "./receiptStore.js";
import { LEDGER_REL } from "./ledger.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

function ledgerClaimFails(cwd: string): number {
  const p = join(cwd, LEDGER_REL);
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const ln of readFileSync(p, "utf8").split("\n")) {
    if (!ln.trim()) continue;
    try {
      if ((JSON.parse(ln) as { claimMatched?: unknown }).claimMatched === false) n++;
    } catch {
      /* skip */
    }
  }
  return n;
}

/**
 * `agent-receipt incident [--since <n>]` — 최근 receipts/ledger 에서 실패·위험 변경·승인 누락·서명 부재를
 * 모아 요약한다(사고 조사 모드). 자동 복구/revert·점수화 없음 — 설명과 증거만.
 */
export function runIncident(sinceArg: string | undefined, cwd: string = process.cwd()): never {
  const all = listReceipts(cwd).filter((e) => e.name.endsWith(".json")); // 최신 우선
  const since = sinceArg ? Math.max(1, Number(sinceArg) || all.length) : all.length; // 13차 council(#4): 무효값→전체(insights 와 정합·사고 은폐 방향 제거)
  const recent = all.slice(0, since);

  const failed: string[] = [];
  const critical: string[] = [];
  const approvalMissing: string[] = [];
  const unsigned: string[] = [];
  let lastPass: string | null = null;

  for (const e of recent) {
    const o = parseReceiptJson(e.abs);
    if (!o) continue;
    const tag = `${o.timestamp ?? "?"} ${o.contractId ?? "?"} (${e.name})`;
    if (o.ok === false) failed.push(tag);
    if (o.ok === true && !lastPass) lastPass = tag;
    const crit = criticalTouchedCount(o);
    if (crit > 0) {
      critical.push(`${tag} — critical ${crit}건`);
      if (!hasApproval(e.abs)) approvalMissing.push(tag);
    }
    if (!hasSignature(e.abs)) unsigned.push(tag);
  }

  const claimFails = ledgerClaimFails(cwd);

  console.log("");
  console.log(line);
  console.log(`agent-receipt incident  (최근 ${recent.length}/${all.length} receipts — 사고 조사, 자동복구 안 함)`);
  console.log(line);

  const section = (title: string, items: string[], emptyMsg: string): void => {
    console.log(`${title} (${items.length}):`);
    if (!items.length) console.log(`  ${emptyMsg}`);
    else for (const x of items.slice(0, 20)) console.log(`  - ${x}`);
  };

  section("실패한 receipt(ok=false)", failed, "없음");
  section("고위험 경로 변경(critical touched)", critical, "없음");
  section("승인 누락(critical 변경인데 approval sidecar 없음)", approvalMissing, "없음");
  if (claimFails) console.log(`claim mismatch(원장 기록): ${claimFails}건`);
  console.log(`서명 없는 receipt: ${unsigned.length}건 (정보용 — 필요 시 keys init → sign)`);
  console.log("");
  console.log(`마지막 PASS: ${lastPass ?? "(최근 범위 내 없음)"}`);

  console.log("");
  console.log("다음 조치(자동 아님):");
  if (failed.length) console.log("  → 실패 receipt 의 계약/변경을 `explain`·`receipts --cat` 로 확인");
  if (approvalMissing.length) console.log("  → 위험 변경 receipt 에 `approve --receipt <path>` 로 승인 기록");
  if (claimFails) console.log("  → claim mismatch 는 `claims --file <claim.json>` 로 AI 보고 ↔ git 재대조");
  if (!failed.length && !approvalMissing.length && !claimFails) console.log("  → 특이사항 없음. 정기적으로 `audit-pack` 으로 증거를 보존하세요.");

  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
