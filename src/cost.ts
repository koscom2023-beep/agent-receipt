import { summarizeCurrentSession, CONTEXT_BLOAT_TOKENS, type TranscriptSummary } from "./transcript.js";
import { fmtUsd, PRICING_AS_OF } from "./pricing.js";
import { LIMIT_NOTE } from "./disclosure.js";

// ── cost (council 2026-07-03·화폐화) — 현 세션의 실제 토큰 비용 요약(로컬 transcript·읽기전용) ──
// 정직: Anthropic 자신의 usage 데이터 × 리스트 가격 = 추정치(청구서 아님·할인/인트로 미반영). "~" 표기.
// 지표 규율: cache_read 큼 = 낭비 아님(캐시가 아껴준 것). bloat 신호는 컨텍스트 정점만.

const line = "─".repeat(56);
const n = (x: number): string => x.toLocaleString("en-US");

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
export function runCost(format: string | undefined, sessionId: string | undefined, cwd: string = process.cwd()): never {
  const s = summarizeCurrentSession(cwd, sessionId);
  if (format === "json") {
    process.stdout.write(JSON.stringify(toJson(s), null, 2) + "\n");
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log("agent-receipt cost — 이 세션의 실제 토큰 비용 (로컬 transcript·읽기전용)");
  console.log(line);
  for (const l of costLines(s)) console.log(l);
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

// 형제 표면(done 등)용 1줄 — 미지원/0이면 null(출력 불변).
export function sessionCostLine(cwd: string = process.cwd()): string | null {
  try {
    const s = summarizeCurrentSession(cwd);
    if (!s.supported || !s.messages) return null;
    const bloat = s.contextPeak >= CONTEXT_BLOAT_TOKENS ? ` · ⚠️ 컨텍스트 ${n(s.contextPeak)}(새 세션 권장)` : "";
    return `이 세션 비용(추정·청구서 아님): ~${fmtUsd(s.cost)} · 메시지 ${n(s.messages)}${bloat}`;
  } catch {
    return null;
  }
}
