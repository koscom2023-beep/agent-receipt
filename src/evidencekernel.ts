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

// ── 날짜 검증 커널 (Phase3) ──
// 형식 무관 정규화(YYYY-MM-DD): 서로 다른 표기의 같은 날을 결정론으로 일치시킨다(TZ 비의존·문자열만).
export type DateStatus = "verified" | "mismatch" | "no-basis";
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const pad2 = (s: string): string => (s.length === 1 ? "0" + s : s);

// 지원 형식만 결정론 정규화 → "YYYY-MM-DD". 그 외 → null(파싱 불가·검증 안 함).
export function canonicalizeDate(s: string): string | null {
  const t = s.trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2] as string)}-${pad2(m[3] as string)}`;
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/); // Jan 5, 2026 / January 5 2026
  if (m) { const mo = MONTHS[(m[1] as string).slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${mo}-${pad2(m[2] as string)}`; }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/); // 5 Jan 2026
  if (m) { const mo = MONTHS[(m[2] as string).slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${mo}-${pad2(m[1] as string)}`; }
  return null;
}

// 텍스트에서 날짜형 토큰을 뽑아 정규화한 집합.
export function datesInText(text: string): string[] {
  const out = new Set<string>();
  const pats = [
    /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
    /\b[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/g,
    /\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\b/g,
  ];
  for (const re of pats) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const c = canonicalizeDate(m[0]);
      if (c) out.add(c);
    }
  }
  return [...out];
}

export function dateStatus(statedDate: string | null, source: string | null): DateStatus {
  if (!statedDate) return "no-basis";
  const c = canonicalizeDate(statedDate);
  if (!c || typeof source !== "string") return "no-basis";
  const found = datesInText(source);
  if (!found.length) return "no-basis";
  return found.includes(c) ? "verified" : "mismatch";
}

// ── 링크 well-formedness (Phase3·순수) ──
// 도달성(라이브 resolve)은 --fetch 의 몫. 여기선 형식만: http(s) URL 인가(valid=advisory·증거 아님).
export type LinkStatus = "valid" | "invalid";
export function linkStatus(url: string): LinkStatus {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

// ── 통합 claim 평가 (표준 포맷의 단일 의미론 — research·council 이 공유) ──
// 코드가 곧 포맷 스펙: 한 주장이 담은 각 typed 근거(인용/수치/날짜/링크)를 한 곳에서 결정론 판정.
export interface EvalClaimInput {
  quotedText?: unknown;
  statedValue?: unknown;
  op?: unknown;
  operands?: unknown;
  eps?: unknown;
  statedDate?: unknown;
  link?: unknown; // 형식 검증할 URL(surface 가 sourceUrl 을 넘길 수 있음)
}
export interface ClaimEvaluation {
  citation: CitationStatus | null;
  number: NumberStatus | null;
  date: DateStatus | null;
  link: LinkStatus | null;
  failed: boolean; // 어느 근거든 불일치(not-found/mismatch/invalid)
  verified: boolean; // 실증된 근거 1+ 이고 불일치 0
}

function parseStated(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function evaluateClaim(c: EvalClaimInput, source: string | null): ClaimEvaluation {
  const quote = typeof c.quotedText === "string" ? c.quotedText : "";
  const citation = quote ? citationStatus(quote, source) : null;
  const number =
    c.statedValue !== undefined
      ? numberStatus(parseStated(c.statedValue), {
          source,
          op: c.op,
          operands: Array.isArray(c.operands) ? (c.operands as number[]) : undefined,
          eps: typeof c.eps === "number" ? c.eps : undefined,
        })
      : null;
  const date = c.statedDate !== undefined ? dateStatus(typeof c.statedDate === "string" ? c.statedDate : null, source) : null;
  const link = typeof c.link === "string" ? linkStatus(c.link) : null;
  const failed = citation === "not-found" || number === "mismatch" || date === "mismatch" || link === "invalid";
  // link valid=advisory(증거 아님) → verified 에 기여 안 함.
  const verified = !failed && (citation === "verified" || number === "verified" || date === "verified");
  return { citation, number, date, link, failed, verified };
}
