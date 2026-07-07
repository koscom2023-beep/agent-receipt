import { summarizeCurrentSession, summarizeProjectToday, CONTEXT_BLOAT_TOKENS, type TranscriptSummary, type TodayTotal } from "./transcript.js";
import { fmtUsd, PRICING_AS_OF, priceFor, normalizeModelId, costOf, type UsageTokens } from "./pricing.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// 오늘(UTC) 날짜 — 런타임 CLI 경로에서만 호출(Date 격리는 순수 합산 함수 쪽). transcript 는 UTC 타임스탬프.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── cost (council 2026-07-03·화폐화) — 현 세션의 실제 토큰 비용 요약(로컬 transcript·읽기전용) ──
// 정직: Anthropic 자신의 usage 데이터 × 리스트 가격 = 추정치(청구서 아님·할인/인트로 미반영). "~" 표기.
// 지표 규율: cache_read 큼 = 낭비 아님(캐시가 아껴준 것). bloat 신호는 컨텍스트 정점만.

const line = "─".repeat(56);
const n = (x: number): string => x.toLocaleString("en-US");

// 오늘 누적 1줄(순수 합산·오탐 0). 세션 0이면 null. today 주입(테스트 결정론).
export function todayLine(t: TodayTotal): string | null {
  if (!t.supported || !t.sessions) return null;
  return `오늘(${t.date}) 누적(추정·청구서 아님): ~${fmtUsd(t.cost)} · 세션 ${t.sessions}개${t.hasUnpriced ? " (일부 가격 미상)" : ""}`;
}

// 사람용 표시줄(형제 표면 재사용). supported=false 면 이유 1줄만.
export function costLines(s: TranscriptSummary): string[] {
  if (!s.supported) return [`비용 계량: ${s.reason ?? "미지원"}`];
  const L: string[] = [];
  L.push(`이 세션 비용(추정·리스트가·청구서 아님): ~${fmtUsd(s.cost)}${s.hasUnpriced ? " (일부 모델 가격 미상=부분)" : ""}`);
  L.push(`메시지 ${n(s.messages)} · 출력 ${n(s.tokens.output)} 토큰 · 캐시읽기 ${n(s.tokens.cacheRead)} · 캐시생성 ${n(s.tokens.cacheCreation)}`);
  for (const m of s.byModel) L.push(`  ${m.model}: ~${fmtUsd(m.cost)}`);
  if (s.contextPeak >= CONTEXT_BLOAT_TOKENS) {
    L.push(`⚠️ 컨텍스트 정점 ${n(s.contextPeak)} 토큰 — 길어졌습니다. 새 세션이 매 턴 재전송(캐시읽기+재캐싱) 비용을 낮출 수 있습니다.`);
  }
  return L;
}

// ── P1 v0.18 (council D4): "왜 비쌌나" — 구성요소 분해 + 고정 규칙 신호 ──
// 🔴 경계(DA-2 재확인): 판정어 0("낭비/비효율" 금지) — 사실 분해 + 조건 자백 신호만. verdict 에 절대 유입 금지.
//   분해 공식 = costOf 와 동일(cacheCreation 은 5m 단가 상한 추정 — transcript 에 1h 구분 없음) → 합계가 s.cost 와 일치.
export type CostComponent = "input" | "output" | "cacheRead" | "cacheCreation";
export interface CostComponentRow {
  component: CostComponent;
  cost: number;
  share: number; // priced 합 대비 비율(0~1)
}
export interface CostDiagnosis {
  pricedTotal: number; // 가격표가 있는 모델만의 합(= hasUnpriced=false 면 s.cost 와 동일)
  components: CostComponentRow[]; // cost 내림차순
  signals: string[]; // 고정 규칙 신호 — 각 줄에 발동조건 자백(판정어 0)
  unpricedModels: number; // 분해에서 제외된 모델 수(추정 금지)
}
const COMPONENT_LABEL: Record<CostComponent, string> = {
  input: "입력(비캐시)",
  output: "출력(생성)",
  cacheRead: "캐시 읽기(컨텍스트 재전송)",
  cacheCreation: "캐시 생성(재캐싱)",
};
export function diagnoseCost(s: TranscriptSummary): CostDiagnosis | null {
  if (!s.supported || !s.byModel.length) return null;
  const comp: Record<CostComponent, number> = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let unpricedModels = 0;
  for (const m of s.byModel) {
    const p = priceFor(m.model);
    if (!p) {
      unpricedModels++;
      continue; // 가격 미상 — 분해에서 제외(추정 금지)
    }
    const per = (tok: number, rate: number): number => (tok / 1_000_000) * rate;
    comp.input += per(m.tokens.input, p.input);
    comp.output += per(m.tokens.output, p.output);
    comp.cacheRead += per(m.tokens.cacheRead, p.cacheRead);
    comp.cacheCreation += per(m.tokens.cacheCreation, p.cacheWrite5m); // costOf 와 동일 가정(1h 구분 없음=5m 상한)
  }
  const pricedTotal = comp.input + comp.output + comp.cacheRead + comp.cacheCreation;
  const components: CostComponentRow[] = (Object.keys(comp) as CostComponent[])
    .map((c) => ({ component: c, cost: comp[c], share: pricedTotal > 0 ? comp[c] / pricedTotal : 0 }))
    .sort((a, b) => b.cost - a.cost || (a.component < b.component ? -1 : 1));
  const signals: string[] = [];
  const pct = (x: number): number => Math.round(x * 100);
  const top = components[0];
  if (pricedTotal > 0 && top && top.share >= 0.5) {
    signals.push(`가장 큰 몫: ${COMPONENT_LABEL[top.component]} ${pct(top.share)}% (규칙: 최대 구성요소 ≥50% 일 때 표시)`);
  }
  if (s.contextPeak >= CONTEXT_BLOAT_TOKENS) {
    signals.push(`컨텍스트 정점 ${n(s.contextPeak)} 토큰 — 이후 턴마다 그 크기를 다시 처리 (규칙: 정점 ≥${n(CONTEXT_BLOAT_TOKENS)})`);
  }
  if (comp.cacheCreation > comp.cacheRead && comp.cacheCreation > 0) {
    signals.push("캐시 생성비 > 캐시 읽기비 — 재캐싱 비중이 큼(캐시 간격·컨텍스트 변경) (규칙: 생성비>읽기비)");
  }
  const topModel = s.byModel[0];
  if (topModel && topModel.cost != null && s.cost != null && s.cost > 0 && topModel.cost / s.cost >= 0.7) {
    signals.push(`모델 집중: ${topModel.model} 가 비용의 ${pct(topModel.cost / s.cost)}% (규칙: 최상위 모델 ≥70%)`);
  }
  return { pricedTotal, components, signals, unpricedModels };
}
// 사람용 진단 줄(고정 규칙·판정 아님). 진단 불가면 [](출력 불변).
export function diagnosisLines(d: CostDiagnosis | null): string[] {
  if (!d || d.pricedTotal <= 0) return [];
  const L: string[] = [];
  L.push("왜 비쌌나(추정 분해 — 사실 나열·판정 아님):");
  L.push("  " + d.components.map((c) => `${COMPONENT_LABEL[c.component]} ~${fmtUsd(c.cost)} (${Math.round(c.share * 100)}%)`).join(" · "));
  for (const sig of d.signals) L.push(`  · ${sig}`);
  if (d.unpricedModels > 0) L.push(`  · 가격 미상 모델 ${d.unpricedModels}개 — 분해에서 제외(추정 금지)`);
  return L;
}

function toJson(s: TranscriptSummary): Record<string, unknown> {
  return {
    supported: s.supported,
    reason: s.reason ?? null,
    pricingAsOf: s.pricingAsOf,
    disclaimer: "list-price estimate from the local transcript (Anthropic's own usage data) — not an invoice; excludes discounts/intro pricing",
    messages: s.messages,
    tokens: s.tokens,
    cost: s.cost,
    hasUnpriced: s.hasUnpriced,
    contextPeak: s.contextPeak,
    contextBloat: s.contextPeak >= CONTEXT_BLOAT_TOKENS,
    byModel: s.byModel,
    toolCounts: s.toolCounts,
    window: { first: s.firstTs ?? null, last: s.lastTs ?? null },
  };
}

/** `agent-receipt cost [--format md|json] [--session <file-id>]` — 현 세션 비용 요약. 읽기전용·exit 0. */
// ── R10: 모델치환 감사 — 선언 모델 vs 실제 모델 대조 + 비용차 정량화 ──
// 정직(회의): declared/actual 라벨은 입력(usage 로그·응답 헤더)에서 온다. **actual 라벨 자체의 진실성은 보증하지 않는다**
//   — 이 감사는 그 두 라벨이 뜻하는 *비용차*를 결정론으로 계량할 뿐. 가격 미상 모델=unpriced(추정 금지).
export interface SwapRecord {
  declaredModel: string; // 청구/약속된 모델
  actualModel: string; // 실제 응답 모델(usage/헤더)
  usage: UsageTokens;
}
export interface SwapAuditRow {
  declaredModel: string;
  actualModel: string;
  swapped: boolean;
  declaredCost: number | null;
  actualCost: number | null;
  delta: number | null; // declared - actual (양수=선언이 더 비쌈=다운그레이드 의심)
  direction: "same-model" | "downgrade" | "upgrade" | "same-price" | "unpriced";
}
export interface SwapAudit {
  rows: SwapAuditRow[];
  totalRecords: number;
  swaps: number;
  downgrades: number; // 선언 premium·실제 cheaper(과대청구 의심)
  totalDelta: number; // priced delta 합(USD)
  unpriced: number;
  pricingAsOf: string;
}
export function auditModelSwap(records: SwapRecord[]): SwapAudit {
  const rows: SwapAuditRow[] = [];
  let swaps = 0, downgrades = 0, totalDelta = 0, unpriced = 0;
  for (const rec of records) {
    const dn = normalizeModelId(rec.declaredModel);
    const an = normalizeModelId(rec.actualModel);
    const swapped = dn !== "" && an !== "" && dn !== an;
    const dc = costOf(rec.usage, rec.declaredModel);
    const ac = costOf(rec.usage, rec.actualModel);
    const delta = dc !== null && ac !== null ? dc - ac : null;
    let direction: SwapAuditRow["direction"];
    if (!swapped) direction = "same-model";
    else if (delta === null) { direction = "unpriced"; unpriced++; }
    else if (delta > 0) { direction = "downgrade"; downgrades++; }
    else if (delta < 0) direction = "upgrade";
    else direction = "same-price";
    if (swapped) swaps++;
    if (delta !== null) totalDelta += delta;
    rows.push({ declaredModel: rec.declaredModel, actualModel: rec.actualModel, swapped, declaredCost: dc, actualCost: ac, delta, direction });
  }
  return { rows, totalRecords: records.length, swaps, downgrades, totalDelta, unpriced, pricingAsOf: PRICING_AS_OF };
}
export function renderSwapAuditMd(a: SwapAudit): string {
  const L: string[] = [];
  L.push("# 모델치환 감사 (agent-receipt)");
  L.push("");
  L.push(`> declared 모델 ↔ actual 모델 대조 + 비용차(리스트 가격·${a.pricingAsOf}). **actual 라벨의 진실성은 보증하지 않음** — 두 라벨의 비용 함의만 계량. 가격 미상=unpriced(추정 없음).`);
  L.push("");
  L.push("| declared | actual | swap | declared $ | actual $ | Δ(decl-act) | 판정 |");
  L.push("|----------|--------|------|-----------|----------|-------------|------|");
  for (const r of a.rows) {
    L.push(`| ${r.declaredModel} | ${r.actualModel} | ${r.swapped ? "⚠" : "·"} | ${fmtUsd(r.declaredCost)} | ${fmtUsd(r.actualCost)} | ${r.delta === null ? "?" : fmtUsd(r.delta)} | ${r.direction} |`);
  }
  L.push("");
  L.push(`합계: 레코드 ${a.totalRecords} · 치환 ${a.swaps} · 다운그레이드(과대청구 의심) ${a.downgrades} · Δ합 ${fmtUsd(a.totalDelta)} · unpriced ${a.unpriced}`);
  L.push(`> ${LIMIT_NOTE}`);
  return L.join("\n");
}
const numOr0 = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
export function runSwapAudit(fileArg: string | undefined, format: string | undefined): never {
  if (!fileArg) {
    console.error("cost --audit-swap: --file <usage.json> 가 필요합니다 ({records:[{declaredModel,actualModel,usage:{input,output,cacheRead,cacheCreation}}]}).");
    process.exit(2);
  }
  const p = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    console.error(`cost --audit-swap: 파일을 못 읽음: ${fileArg}`);
    process.exit(2);
  }
  let recs: SwapRecord[] = [];
  try {
    const j: unknown = JSON.parse(raw);
    const arr: unknown[] = Array.isArray(j)
      ? j
      : j && typeof j === "object" && Array.isArray((j as { records?: unknown }).records)
        ? (j as { records: unknown[] }).records
        : [];
    recs = arr
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
      .map((r) => {
        const u = (r.usage && typeof r.usage === "object" ? r.usage : {}) as Record<string, unknown>;
        return {
          declaredModel: typeof r.declaredModel === "string" ? r.declaredModel : "",
          actualModel: typeof r.actualModel === "string" ? r.actualModel : "",
          usage: { input: numOr0(u.input), output: numOr0(u.output), cacheRead: numOr0(u.cacheRead), cacheCreation: numOr0(u.cacheCreation) },
        };
      });
  } catch {
    console.error(`cost --audit-swap: JSON 파싱 실패: ${fileArg}`);
    process.exit(2);
  }
  if (recs.length === 0) {
    console.error(`cost --audit-swap: records 0건: ${fileArg}`);
    process.exit(2);
  }
  const audit = auditModelSwap(recs);
  process.stdout.write((format === "json" ? JSON.stringify(audit, null, 2) : renderSwapAuditMd(audit)) + "\n");
  // 다운그레이드(과대청구 의심) 있으면 exit 1(CI 신호·opt-in)·없으면 0.
  process.exit(audit.downgrades > 0 ? 1 : 0);
}

export function runCost(format: string | undefined, sessionId: string | undefined, cwd: string = process.cwd()): never {
  const s = summarizeCurrentSession(cwd, sessionId);
  const diag = diagnoseCost(s); // P1 D4 — 실패/미지원이면 null(출력 불변)
  if (format === "json") {
    const t = summarizeProjectToday(cwd, todayUtc());
    process.stdout.write(JSON.stringify({ ...toJson(s), diagnosis: diag, today: { date: t.date, sessions: t.sessions, cost: t.cost, hasUnpriced: t.hasUnpriced } }, null, 2) + "\n");
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log("agent-receipt cost — 이 세션의 실제 토큰 비용 (로컬 transcript·읽기전용)");
  console.log(line);
  for (const l of costLines(s)) console.log(l);
  for (const l of diagnosisLines(diag)) console.log(l); // P1 D4 — 구성요소 분해+고정 신호(판정어 0)
  const tl = todayLine(summarizeProjectToday(cwd, todayUtc())); // 오늘 누적(순수 합산)
  if (tl) console.log(tl);
  if (s.supported) {
    if (s.toolCounts.length) console.log(`도구 호출: ${s.toolCounts.slice(0, 6).map((t) => `${t.tool} ${t.count}`).join(" · ")}`);
    console.log(line);
    console.log(`  가격표 기준: ${PRICING_AS_OF} 리스트가 · Anthropic usage × 리스트가 = 추정(청구서 아님·할인/인트로 미반영).`);
    console.log(`  ⓘ 캐시읽기가 커도 낭비가 아닙니다 — 캐시가 매 턴 컨텍스트를 90% 싸게 재전송해 준 것입니다.`);
  }
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}

// 형제 표면(done 등)용 1줄 — 미지원/0이면 null(출력 불변). changed=git 변경 파일 수(호출부 주입) —
// 사실 병치(도구 N·비용 $X·git 변경 M): "무진전" 판정어 없이 나란히 두고 판단은 사람 몫(council 결정 5).
export function sessionCostLine(cwd: string = process.cwd(), changedFiles?: number): string | null {
  try {
    const s = summarizeCurrentSession(cwd);
    if (!s.supported || !s.messages) return null;
    const tools = s.toolCounts.reduce((a, t) => a + t.count, 0);
    const bloat = s.contextPeak >= CONTEXT_BLOAT_TOKENS ? ` · ⚠️ 컨텍스트 ${n(s.contextPeak)}(새 세션 권장)` : "";
    const changed = changedFiles != null ? ` · git 변경 ${changedFiles}파일` : "";
    return `이 세션: 도구 ${n(tools)}회 · 비용 ~${fmtUsd(s.cost)}(추정·청구서 아님) · 메시지 ${n(s.messages)}${changed}${bloat}`;
  } catch {
    return null;
  }
}
