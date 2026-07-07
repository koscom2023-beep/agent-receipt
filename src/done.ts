import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, writeReceiptFile } from "./receipt.js";
import { claimVerify } from "./auditpack.js";
import { appendLedger, ledgerEntryFromReceipt } from "./ledger.js";
import { listReceipts, approvalsCountFor } from "./receiptStore.js";
import { guardWasteSummaryLine } from "./capture.js";
import { collectRedFlags, redFlagLine } from "./reviewfocus.js";
import { sessionCostLine } from "./cost.js";
import { sessionVerdict, buildContractSnapshot, renderVerdictLine, renderContractLine, failOnDoneTriggers } from "./verdict.js";
import { loadPolicySafe } from "./policy.js";
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

  // P0 v0.17 (D1·D2): 세션 판정(게이트·점수 아님) + 계약 스냅샷 — 기존 신호의 순수 롤업.
  const gw = guardWasteSummaryLine(); // 가드/반복 1줄 — capture 없거나 전부 0이면 null=출력 불변
  const redFlags = collectRedFlags(r.touched, r.untracked);
  const rf = redFlagLine(redFlags);
  const redFlagFacts = [
    ...redFlags.skipOnly.map((s) => `test .only/.skip: ${s.path}(${s.count})`),
    ...redFlags.depsAdded.map((d) => `의존성 추가: ${d}`),
  ];
  const vr = sessionVerdict(r, { wasteSignal: !!gw, redFlags: redFlagFacts });
  const snapshot = buildContractSnapshot(contract, r);
  r.verdict = vr; // metadata — contentHash 는 이미 봉인(receiptHash 입력 제외 → 바이트불변)
  r.contractSnapshot = snapshot;

  // P1 D3: policy fail_on_done(opt-in) — 판정이 임계 이상이면 exit 만 1 로(판정/reasons 불변·원인 자백 1줄).
  const { policy, error: policyError } = loadPolicySafe(cwd);
  const fod = policy?.fail_on_done;
  const escalated = !!fod && r.ok && failOnDoneTriggers(vr.verdict, fod);

  console.log("");
  console.log(line);
  console.log(`agent-receipt done: ${r.contractId}`);
  console.log(renderVerdictLine(vr));
  console.log(renderContractLine(snapshot));
  for (const reason of vr.reasons) console.log(`  · ${reason}`);
  if (escalated) console.log(`  ⛔ policy fail_on_done=${fod}: 판정 ${vr.verdict} 이 임계 도달 — exit 1 (게이트 opt-in·판정 자체는 위 사실 그대로)`);
  if (policyError) console.log(`  ⚠️ policy.yaml 오류 — fail_on_done 게이트 미적용(침묵 방지 자백): ${policyError.split("\n")[0]}`); // review: 깨진 policy 로 게이트가 조용히 꺼지는 것 방지
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
  if (gw) console.log(gw); // 가드/반복 상세(판정 reasons 는 이 줄을 참조만 — 중복 서술 없음)
  if (rf) console.log(rf); // 확인 신호 상세
  const cl = sessionCostLine(process.cwd(), r.touched.length + r.untracked.length); // 세션 활동 1줄(도구·비용·git변경 병치) — transcript 없으면 null
  if (cl) console.log(cl);
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
  process.exit(!r.ok || escalated ? 1 : 0);
}
