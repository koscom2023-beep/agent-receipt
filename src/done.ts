import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, writeReceiptFile } from "./receipt.js";
import { claimVerify } from "./auditpack.js";
import { appendLedger, ledgerEntryFromReceipt } from "./ledger.js";
import { listReceipts, approvalsCountFor } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

/**
 * `agent-receipt done [--claim <path>] [--client] [--ledger]` — 작업 종료를 한 명령으로.
 *   run+check(=buildReceipt) → receipt 저장 → 최신 요약 → (claim 대조) → commit-check 안내.
 * exit = receipt.ok ? 0 : 1.
 */
export function runDone(
  contract: Contract,
  contractPath: string | undefined,
  claimArg: string | undefined,
  client: boolean,
  toLedger: boolean,
  cwd: string = process.cwd(),
): never {
  const r = buildReceipt(contract, contractPath);

  console.log("");
  console.log(line);
  console.log(`agent-receipt done: ${r.contractId}  — ${r.ok ? "PASS ✅" : "FAIL ❌"}`);
  console.log(line);

  // receipt 저장(json 항상 — ledger/commit-check 가 참조). --client 면 client-md 도 추가.
  const json = writeReceiptFile(r, "json", undefined, false);
  console.log(`receipt 저장: ${json.rel}`);
  if (client) {
    const cm = writeReceiptFile(r, "client-md", undefined, false);
    console.log(`고객용 보고서: ${cm.rel}`);
  }

  // 변경/검사 요약.
  console.log(`변경: touched ${r.touched.length}, untracked ${r.untracked.length}, denied ${r.deniedHits.length}, outOfScope ${r.outOfScope.length}`);
  const failedChecks = r.checks.filter((c) => !c.ok).length;
  console.log(`검사: ${r.checks.length ? `${r.checks.length - failedChecks}/${r.checks.length} 통과` : "명령 없음(통과 처리)"}`);
  const crit = r.criticalPaths.filter((c) => c.touched.length);
  if (crit.length) console.log(`⚠️ 고위험 경로: ${crit.map((c) => c.glob).join(", ")}`);
  if (r.policy?.forbidAlwaysHits.length) console.log(`⛔ 상시금지(policy): ${r.policy.forbidAlwaysHits.join(", ")}`);

  // claim 대조(있으면).
  let claimMatched: boolean | null = null;
  if (claimArg) {
    const cpath = isAbsolute(claimArg) ? claimArg : join(cwd, claimArg);
    if (!existsSync(cpath)) {
      console.log(`claim: 파일 없음(${claimArg}) — 대조 생략`);
    } else {
      try {
        const parsed: unknown = JSON.parse(readFileSync(cpath, "utf8"));
        const cv = claimVerify(parsed, r.touched, r.untracked, r.deniedHits);
        claimMatched = cv.ok;
        console.log(`claim 대조: ${cv.ok ? "일치 ✅" : "mismatch ❌ (git 을 믿으세요)"}`);
        for (const f of cv.fields.filter((x) => !x.ok)) {
          if (f.hidden.length) console.log(`  ✗ ${f.field}: AI 미보고(git 존재) — ${f.hidden.join(", ")}`);
          if (f.extra.length) console.log(`  ✗ ${f.field}: git 에 없는 주장 — ${f.extra.join(", ")}`);
        }
        const pc = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
        if (pc["modeClaims"] !== undefined || pc["externalActions"] !== undefined) {
          console.log("  ⓘ modeClaims/externalActions 는 self-report — git 검증 대상 아님(advisory). 상세: agent-receipt claims --file");
        }
      } catch {
        console.log(`claim: JSON 파싱 실패(${claimArg}) — 대조 생략`);
      }
    }
  }

  // 원장 적립(옵션).
  if (toLedger) {
    const latest = listReceipts(cwd).filter((e) => e.name.endsWith(".json"))[0] ?? null;
    const approvals = latest ? approvalsCountFor(latest.abs) : 0;
    const led = appendLedger(ledgerEntryFromReceipt(r, json.rel, approvals, claimMatched), cwd);
    console.log(`원장 적립: ${led}`);
  }

  console.log(line);
  console.log("다음: 사람이 직접 stage/commit 하세요.");
  console.log("  → 커밋 전 확인:  agent-receipt commit-check");
  console.log("  → 증거 묶음:     agent-receipt audit-pack [--claim <claim.json>]");
  console.log("  " + LIMIT_NOTE);
  console.log(line);
  console.log("");
  process.exit(r.ok ? 0 : 1);
}
