import { listReceipts, parseReceiptJson, criticalTouchedCount, RECEIPTS_REL, type ReceiptJson } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";

// ── 로컬 분석 (9차 council) — 읽기전용 투영: receipts 의 *기간대비 추세 + 재발 패턴* (audit/incident 가 못 주던 빈 곳만) ──
// 정직 doctrine: 점수·등급·'예측' 없음(서술만) · n 작으면 'small sample, directional only' 강제 · LIMIT_NOTE 승계.
//   totals=audit, 개별 실패나열=incident 참조(재탕 금지). team/org/multi-dev 집계=enterprise(범위 밖). receipts 미변경.

const SMALL_N = 6; // 이 미만이면 추세 단정 금지(방향성만).
const line = "─".repeat(56);

export interface ContractStat {
  contractId: string;
  total: number;
  fail: number;
}
export interface InsightsResult {
  n: number;
  smallSample: boolean;
  window: { prior: number; recent: number };
  failRate: { prior: number | null; recent: number | null }; // percent, half 가 비면 null
  critical: { prior: number; recent: number };
  contracts: ContractStat[];
  recurringFailures: ContractStat[]; // fail >= 2
  watch: string[];
}

/** 순수: receipts(순서 무관) → 기간대비+재발+watch. 결정론(timestamp 오름차순 분할). 점수/예측 없음. */
export function computeInsights(receipts: ReceiptJson[]): InsightsResult {
  const sorted = [...receipts].sort((a, b) => {
    const ta = a.timestamp ?? "";
    const tb = b.timestamp ?? "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const prior = sorted.slice(0, mid); // 오래된 절반
  const recent = sorted.slice(mid); // 최신 절반
  const failRateOf = (arr: ReceiptJson[]): number | null =>
    arr.length ? Math.round((arr.filter((o) => o.ok === false).length / arr.length) * 100) : null;
  const critOf = (arr: ReceiptJson[]): number => arr.reduce((s, o) => s + criticalTouchedCount(o), 0);

  const byContract = new Map<string, ContractStat>();
  for (const o of sorted) {
    const id = o.contractId ?? "(unknown)";
    const c = byContract.get(id) ?? { contractId: id, total: 0, fail: 0 };
    c.total++;
    if (o.ok === false) c.fail++;
    byContract.set(id, c);
  }
  const contracts = [...byContract.values()].sort((a, b) => b.fail - a.fail || b.total - a.total);
  const recurringFailures = contracts.filter((c) => c.fail >= 2);

  const frP = failRateOf(prior);
  const frR = failRateOf(recent);
  const critP = critOf(prior);
  const critR = critOf(recent);
  const watch: string[] = [];
  if (frP !== null && frR !== null && frR > frP) watch.push(`Recent FAIL rate (${frR}%) is higher than the prior window (${frP}%) — review recent receipts.`);
  for (const c of recurringFailures) watch.push(`Contract "${c.contractId}" failed ${c.fail} of ${c.total} runs — recurring.`);
  if (critR > critP) watch.push(`Critical-path touches rose (prior ${critP} -> recent ${critR}) — confirm they were intended.`);

  return {
    n,
    smallSample: n < SMALL_N,
    window: { prior: prior.length, recent: recent.length },
    failRate: { prior: frP, recent: frR },
    critical: { prior: critP, recent: critR },
    contracts,
    recurringFailures,
    watch,
  };
}

const pct = (v: number | null): string => (v === null ? "n/a" : `${v}%`);

/** 순수: 분석 → 사람용 텍스트. 점수/예측 없음·n 작으면 caveat. */
export function renderInsightsMd(r: InsightsResult): string {
  const L: string[] = [];
  L.push("");
  L.push(line);
  L.push(`agent-receipt insights  (${RECEIPTS_REL} — local trend & recurrence)`);
  L.push(line);
  if (r.n === 0) {
    L.push("  receipt 없음 — 'agent-receipt receipt'/'done' 로 쌓은 뒤 다시 보세요(추세는 데이터가 필요).");
    L.push(line);
    L.push("  " + LIMIT_NOTE);
    L.push("");
    return L.join("\n");
  }
  if (r.smallSample) {
    L.push(`  ⚠️ 표본 ${r.n}개 — small sample. 방향성만(directional only) · 추세를 단정하지 않음.`);
  } else {
    L.push(`  표본 ${r.n}개.`);
  }
  L.push("");
  L.push(`  기간 대비 (이전 ${r.window.prior} ↔ 최근 ${r.window.recent}):`);
  L.push(`    FAIL 비율 : ${pct(r.failRate.prior)}  ->  ${pct(r.failRate.recent)}`);
  L.push(`    critical  : ${r.critical.prior}  ->  ${r.critical.recent}`);
  L.push("");
  L.push("  계약별 재발(반복 FAIL 우선):");
  if (!r.contracts.length) L.push("    (없음)");
  for (const c of r.contracts.slice(0, 10)) {
    const mark = c.fail >= 2 ? " ⚠️ recurring" : "";
    L.push(`    ${c.contractId}: ${c.total} runs, ${c.fail} FAIL${mark}`);
  }
  L.push("");
  L.push("  watch (서술 — 점수 아님):");
  if (!r.watch.length) L.push("    특이 추세 없음.");
  for (const w of r.watch) L.push(`    - ${w}`);
  L.push(line);
  L.push("  totals=‘audit’ · 개별 실패/위험 나열=‘incident’ · 다음 한 수=‘next’ 참조.");
  L.push("  " + LIMIT_NOTE);
  L.push("  (서술적 추세·재발일 뿐 — 점수·등급·예측이 아니며, 표본이 작으면 신뢰가 낮습니다.)");
  L.push("");
  return L.join("\n");
}

/** 순수: 분석 → 안정 JSON. */
export function renderInsightsJson(r: InsightsResult): string {
  return JSON.stringify({ ...r, note: "descriptive trend & recurrence only — not scores/grades/predictions; low confidence at small n.", limitNote: LIMIT_NOTE }, null, 2);
}

/** `agent-receipt insights [--since N] [--format md|json]` — receipts 읽기전용 추세/재발 집계. receipts 미변경. exit 0. */
export function runInsights(sinceArg: string | undefined, format: string | undefined, cwd: string = process.cwd()): never {
  const all = listReceipts(cwd).filter((e) => e.name.endsWith(".json"));
  const since = sinceArg ? Math.max(1, Number(sinceArg) || all.length) : all.length;
  const picked = all.slice(0, since); // 최신 N
  const receipts = picked.map((e) => parseReceiptJson(e.abs)).filter((o): o is ReceiptJson => !!o);
  const result = computeInsights(receipts);
  const out = format === "json" ? renderInsightsJson(result) : renderInsightsMd(result);
  process.stdout.write(out + "\n");
  process.exit(0);
}
