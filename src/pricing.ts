// ── 모델 가격표 (claude-api 스킬 실측·2026-01 기준·백만 토큰당 USD) ──
// 정직: 이 표는 *리스트 가격*이다(할인·엔터프라이즈 계약·인트로 프로모션 반영 안 함). Anthropic 자신의
// usage 데이터(실제 토큰)에 곱하지만, 결과는 청구서가 아니라 리스트가 기준 추정치다("~" 표기·청구서 아님 고지).
// cache read/write 는 표준 배수(read 0.1×·write5m 1.25×·write1h 2× of input) — 배수도 리스트 기준.
// 표에 없는 모델은 null → 비용 미계산(추정 날조 금지). 날짜 라벨을 화면에 병기해 노후를 정직하게 드러낸다.

export const PRICING_AS_OF = "2026-01";

export interface ModelPrice {
  input: number; // per 1M tokens
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

// 키는 정확한 모델 ID(접두 매칭 없음 — 오귀속 방지). 별칭/스냅샷은 normalizeModelId 로 좁힌다.
const TABLE: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 }, // 인트로 $2/$10(2026-08-31까지) 미반영=상한 추정
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

// 스냅샷 접미(claude-haiku-4-5-20251001)만 벗겨 정확 키로. 그 외는 그대로(미지 → null).
export function normalizeModelId(model: string | undefined): string {
  if (!model) return "";
  const m = model.trim();
  const snap = m.match(/^(claude-[a-z]+-\d+(?:-\d+)?)-\d{8}$/);
  return snap ? (snap[1] as string) : m;
}

export function priceFor(model: string | undefined): ModelPrice | null {
  return TABLE[normalizeModelId(model)] ?? null;
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

// 한 usage 묶음의 리스트가 기준 비용(USD). 가격 미상 모델이면 null(추정 금지).
// cache creation 은 5m/1h 세분(usage.cache_creation.ephemeral_*)을 못 받을 때 5m 로 보수 가정(더 싼 쪽 — 과대청구 방지).
export function costOf(u: UsageTokens, model: string, oneHourCreation = 0): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const per = (tok: number, rate: number): number => (tok / 1_000_000) * rate;
  const create5m = Math.max(0, u.cacheCreation - oneHourCreation);
  return (
    per(u.input, p.input) +
    per(u.output, p.output) +
    per(u.cacheRead, p.cacheRead) +
    per(create5m, p.cacheWrite5m) +
    per(oneHourCreation, p.cacheWrite1h)
  );
}

export function fmtUsd(n: number | null): string {
  if (n == null) return "?";
  // v0.24 수정(리뷰 #15): 음수(비용 델타·업그레이드 방향) 부호 보존. 이전엔 -$4.80 도 n<0.01 이 참이라
  //   "<$0.01" 로 뭉개 *비용 급증을 은폐*했다. 비음수 출력은 이전과 바이트동일(재귀로 부호만 앞에 붙임).
  if (n < 0) return "-" + fmtUsd(-n);
  if (n < 0.01) return "<$0.01";
  return "$" + n.toFixed(2);
}
