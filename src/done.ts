import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, receiptHash, writeReceiptFile } from "./receipt.js";
import { claimVerify } from "./auditpack.js";
import { appendLedger, ledgerEntryFromReceipt } from "./ledger.js";
import { listReceipts, approvalsCountFor } from "./receiptStore.js";
import { guardWasteSummaryLine } from "./capture.js";
import { collectRedFlags, redFlagLine } from "./reviewfocus.js";
import { sessionCostLine } from "./cost.js";
import { sessionVerdict, buildContractSnapshot, renderVerdictLine, renderContractLine, failOnDoneTriggers } from "./verdict.js";
import { loadPolicySafe } from "./policy.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { renderTermCard, useColor } from "./termcard.js";
import { loadObservationHealth } from "./observation.js";

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
  // P0-1(정본 2026-07-16): 관찰 배선을 판정에 넣는다. 훅을 깔고도 기록이 0이면 PASS 는 과대 주장이다.
  // 배선 안 하면 죽은 코드가 된다. 실제로 이 도구가 44일간 관찰 0인 채 PASS 를 찍은 것이 그 사고였다.
  const obs = loadObservationHealth(cwd);
  const vr = sessionVerdict(r, { wasteSignal: !!gw, redFlags: redFlagFacts, observation: obs });
  const snapshot = buildContractSnapshot(contract, r);
  r.verdict = vr;
  r.contractSnapshot = snapshot;
  // v0.24 보안수정(리뷰 #1 Critical): receiptHash 가 이제 판정(verdict/contractSnapshot 포함)을 봉인하므로,
  //   *부착 후에* 재봉인해야 저장된 contentHash 가 verify-proof 의 재계산과 일치한다. 부착 전에 봉인하면
  //   verify-proof 가 항상 불일치(변조 오탐)로 뜬다. 이 재봉인이 판정 위변조를 실제로 차단하는 지점이다.
  r.contentHash = receiptHash(r);

  // P1 D3: policy fail_on_done(opt-in) — 판정이 임계 이상이면 exit 만 1 로(판정/reasons 불변·원인 자백 1줄).
  const { policy, error: policyError } = loadPolicySafe(cwd);
  const fod = policy?.fail_on_done;
  const escalated = !!fod && r.ok && failOnDoneTriggers(vr.verdict, fod);

  // 터미널 판정 카드(회의 결정) — TTY 일 때만. 비TTY(파이프·CI·테스트)=아래 기존 출력 100% 불변(회귀 0).
  if (process.stdout.isTTY) {
    console.log("");
    console.log(renderTermCard(r, { color: useColor() }));
  }

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
  // mcp-tap 관측 1줄(사실) + 금지행위 클래스 warn-only(결정 12 — 판정·게이트 비유입·deny 없음).
  const ts = r.tapSummary;
  if (ts) {
    const cls = Object.entries(ts.byClass).map(([k, v]) => `${k} ${v}`).join(" · ");
    const extra = [
      ts.coverage.excluded.length ? `제외 ${ts.coverage.excluded.join(",")}` : "",
      ts.coverage.unwrapped?.length ? `미포장 ${ts.coverage.unwrapped.join(",")}` : "",
      ts.coverage.configDrift.length ? `⚠️설정드리프트 ${ts.coverage.configDrift.join(",")}` : "",
      ts.dropped ? `⚠️dropped:${ts.dropped}` : "",
    ].filter(Boolean).join(" · ");
    console.log(`tap 관측: 호출 ${ts.calls} (${cls || "없음"})${extra ? " · " + extra : ""}`);
    const forbidClasses = (policy?.forbid_actions ?? []).filter((c) => (ts.byClass[c] ?? 0) > 0);
    if (forbidClasses.length) console.log(`⚠️ 금지행위(advisory) 클래스가 tap 에 관측됨: ${forbidClasses.map((c) => `${c} ${ts.byClass[c]}건`).join(" · ")} — warn-only(게이트 아님)`);
    // 대사 규칙 2(클래스-수준·스펙 v0.3.1): tap 은 경로를 모른다(값 미저장) — 가능한 사실만 말한다.
    if ((ts.byClass["fs-write"] ?? 0) > 0 && r.touched.length === 0 && r.untracked.length === 0)
      console.log("⚠️ tap fs-write 관측·git 변경 0 — 생성후삭제/ignored/저장소 밖 가능(사실 신호)");
  }

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
  // 결정4+배치A-4 — 판정별 다음 행동 *순서 고정*(①→②→③·기존 명령 안내만·신규 로직 0·강제 아님)
  if (vr.verdict === "PASS") console.log("다음 행동: ① `agent-receipt share-proof`(별칭 share — 공유 HTML) → ② PR 코멘트(GitHub Action) → ③ `--bundle` 보존 + 받는 쪽 `verify-proof`");
  else if (vr.verdict === "PASS_WITH_WARNINGS") console.log("다음 행동: ① 위 신호부터 확인 → ② `share-proof` 로 증거 열람 → ③ `agent-receipt explain` · `note`(판단 기록)");
  else if (vr.verdict === "FAIL") console.log("다음 행동: ① 위 원인 1줄 확인 → ② `agent-receipt explain`(위반 상세) → ③ 수정 후 `done` 재실행");
  else console.log("다음 행동: ① 위 '고치는 법' 적용 → ② `agent-receipt begin` 후 재측정 → ③ `done` 재실행"); // INCOMPLETE
  console.log("다음: 사람이 직접 stage/commit 하세요.");
  console.log("  → 커밋 전 확인:  agent-receipt commit-check");
  console.log("  → 증거 묶음:     agent-receipt audit-pack [--claim <claim.json>]");
  console.log("  " + LIMIT_NOTE);
  console.log(line);
  console.log("");
  process.exit(!r.ok || escalated ? 1 : 0);
}
