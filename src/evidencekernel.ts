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

// ── 수치 검증 커널 (Claude Science 벤치마크 차용 · Phase3) ──
// 리뷰어가 "인용 + 계산식·수치"를 검토하듯, 인용 커널의 형제로 수치를 모델 밖 산술로 대조한다.
// 보증 범위(정직·좁게): "수치가 출처/자기 피연산자와 정합하나"이지 "그 수치가 옳으냐"가 아니다.

export type NumberStatus = "verified" | "mismatch" | "no-basis";

// 텍스트에서 숫자 토큰 추출(천단위 콤마 제거·소수·음수). 퍼센트/단위 기호는 무시하고 수만 뽑음.
export function parseNumbersFromText(text: string): number[] {
  const out: number[] = [];
  const re = /-?\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

export function numbersClose(a: number, b: number, eps: number): boolean {
  return Math.abs(a - b) <= eps;
}

const NUMBER_OPS = ["sum", "mean", "product", "diff", "ratio", "percent", "min", "max"] as const;
export type NumberOp = (typeof NUMBER_OPS)[number];
export function isNumberOp(s: unknown): s is NumberOp {
  return typeof s === "string" && (NUMBER_OPS as readonly string[]).includes(s);
}

// 결정론 재계산. 알 수 없는 op / 잘못된 피연산자 → null.
export function recompute(op: NumberOp, operands: number[]): number | null {
  const xs = operands.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!xs.length) return null;
  switch (op) {
    case "sum": return xs.reduce((a, b) => a + b, 0);
    case "mean": return xs.reduce((a, b) => a + b, 0) / xs.length;
    case "product": return xs.reduce((a, b) => a * b, 1);
    case "diff": return xs.reduce((a, b) => a - b);
    case "ratio": return xs.length >= 2 && xs[1] !== 0 ? (xs[0] as number) / (xs[1] as number) : null;
    case "percent": return xs.length >= 2 && xs[1] !== 0 ? ((xs[0] as number) / (xs[1] as number)) * 100 : null;
    case "min": return Math.min(...xs);
    case "max": return Math.max(...xs);
  }
}

// stated 수치 판정. 모드 B(op+operands 재계산) 우선 → 없으면 모드 A(source 에 실재) → 둘 다 없으면 no-basis.
export function numberStatus(
  stated: number | null,
  opts: { source?: string | null; op?: unknown; operands?: number[]; eps?: number },
): NumberStatus {
  if (stated === null || !Number.isFinite(stated)) return "no-basis";
  const eps = typeof opts.eps === "number" && opts.eps >= 0 ? opts.eps : 1e-9;
  if (isNumberOp(opts.op) && Array.isArray(opts.operands) && opts.operands.length) {
    const r = recompute(opts.op, opts.operands);
    if (r === null) return "no-basis";
    return numbersClose(stated, r, eps) ? "verified" : "mismatch";
  }
  if (typeof opts.source === "string") {
    const nums = parseNumbersFromText(opts.source);
    if (!nums.length) return "no-basis";
    return nums.some((n) => numbersClose(stated, n, eps)) ? "verified" : "mismatch";
  }
  return "no-basis";
}
