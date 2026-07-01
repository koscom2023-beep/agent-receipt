// ── Evidence Kernel (코어·순수 검증) ──
// 피드백(2026-07-01): 코어가 하는 일은 단순 verify 가 아니라 capture→normalize→verify→reconcile→
//   ledger→replay 의 증거처리다. 그 중 "주장이 출처에 실재하나"를 모델 밖 결정론으로 대조하는
//   순수 커널을 여기 모은다. research verify·council verify·(향후) eval verify 가 전부 이걸 재사용.
// 불변식: LLM 판단 0·순수 함수·surface(research/council 등) 를 import 하지 않는다(core ↛ surface).

export type CitationStatus = "verified" | "not-found" | "no-source";

// 공백 정규화(비교 전) — LLM 의견이 아니라 문자열 연산.
export function normalizeForCitation(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// 결정론 커널: quotedText 가 source 의 리터럴(정규화) 부분문자열인지.
export function verifyCitationInText(quote: string, source: string): boolean {
  const q = normalizeForCitation(quote);
  if (q === "") return false;
  return normalizeForCitation(source).includes(q);
}

// 인용 claim 의 상태 판정(순수). quotedText + (sourceText|sourceFile) 를 받는 최소 shape.
export interface CitationClaimLike {
  quotedText?: unknown;
  sourceText?: unknown;
  sourceFile?: unknown;
}

// source 해석은 호출부가 주입(파일 IO 는 커널 밖) — 커널은 순수 유지.
export function citationStatus(quote: string, source: string | null): CitationStatus {
  if (source === null || normalizeForCitation(quote) === "") return "no-source";
  return verifyCitationInText(quote, source) ? "verified" : "not-found";
}
