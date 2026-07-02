import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";

// Evidence Specification 버전 — 검증 포맷(claim/check)의 표준 버전. 남이 채택할 수 있는 표면.
export const SCHEMA_VERSION = "evidence/1";

// ── Evidence Kernel (코어·순수 검증) ──
// 피드백(2026-07-01): 코어가 하는 일은 단순 verify 가 아니라 capture→normalize→verify→reconcile→
//   ledger→replay 의 증거처리다. 그 중 "주장이 출처에 실재하나"를 모델 밖 결정론으로 대조하는
//   순수 커널을 여기 모은다. research verify·council verify·(향후) eval verify 가 전부 이걸 재사용.
// 불변식: LLM 판단 0·순수 함수·surface(research/council 등) 를 import 하지 않는다(core ↛ surface).

// ── Claim fingerprint v1 (시간축 동일성 키 · 결정론) ──
// "같은 주장"을 시간축으로 묶는 식별키 — 증명이 아니라 파생 계산값(tier 개념 비적용).
// 구성: NFC+공백정규화 statement + NUL + sourceUrl(없으면 "") + NUL + 정렬된 checkKinds.
// 표기: `cfp1:<sha256hex>` — 값 자체가 버전을 자기기술(v2 가 나오면 cfp2: 병기·기존 의미 변경 금지).
// 정직 한계(v1): 텍스트 기반 — 문구가 바뀌면 다른 주장으로 취급(의미적 동일성 보장 아님).
//   check 종류 집합이 포함되므로 도구가 검사 종류를 확장하면 같은 주장의 fp 가 갈라질 수 있음(스펙 명시).
export const CLAIM_FINGERPRINT_VERSION = 1;
export function claimFingerprintV1(o: { statement: string; sourceUrl?: string | null; checkKinds: string[] }): string {
  const norm = o.statement.normalize("NFC").replace(/\s+/g, " ").trim();
  const kinds = [...o.checkKinds].sort().join(",");
  const h = createHash("sha256").update([norm, o.sourceUrl ?? "", kinds].join("\u0000")).digest("hex"); // NUL 구분자(필드 충돌 방지)
  return `cfp1:${h}`;
}

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

// ── 해시(무결성) 검증 커널 (Phase3) ──
// content 의 해시가 주장 해시와 일치하나 = 무결성. deterministic 계산(IO 아님·커널 순수 유지).
export type HashStatus = "verified" | "mismatch" | "no-basis";
const HASH_ALGOS = ["sha256", "sha1", "sha512", "md5"];
export function hashStatus(statedHash: string | null, content: string | null, algo: string = "sha256"): HashStatus {
  if (!statedHash || content === null) return "no-basis";
  const a = HASH_ALGOS.includes(algo) ? algo : "sha256";
  const h = createHash(a).update(content).digest("hex");
  return h.toLowerCase() === statedHash.trim().toLowerCase() ? "verified" : "mismatch";
}

// ── 서명(ed25519) 검증 커널 (Phase3) ──
// content 가 이 공개키로 서명됐나 = 부인방지. 자가보고(unsigned)보다 강한 유일한 층.
// 보증 정직: "이 content 가 이 키로 서명됨"의 결정론 확인이지, 사실 보증도 키 신뢰 보증도 아니다(키 신뢰는 밖).
export type SignatureStatus = "verified" | "invalid" | "no-basis";
export function signatureStatus(content: string | null, signature: string | null, publicKey: string | null): SignatureStatus {
  if (content === null || typeof signature !== "string" || !signature || typeof publicKey !== "string" || !publicKey) return "no-basis";
  let key;
  try {
    key = createPublicKey(publicKey); // PEM(SPKI) 공개키
  } catch {
    return "no-basis"; // 키 형식 불가 → 검증 불가
  }
  try {
    return cryptoVerify(null, Buffer.from(content, "utf8"), key, Buffer.from(signature, "base64")) ? "verified" : "invalid";
  } catch {
    return "invalid"; // 서명 형식 깨짐 = 유효하지 않은 서명
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
  statedHash?: unknown; // 무결성: content 의 해시가 이것과 일치하나
  content?: unknown; // 해시/서명 대상 콘텐츠(인라인·surface 가 파일에서 채울 수 있음)
  algo?: unknown; // 해시 알고리즘(기본 sha256)
  signature?: unknown; // base64 ed25519 서명(content 에 대한)
  publicKey?: unknown; // PEM(SPKI) 공개키 — 서명 검증용
}
// Evidence = 실패 check 의 *증명*(expected↔actual). reason 은 설명, evidence 는 결정론 비교 근거.
export interface CheckEvidence {
  expected: string;
  actual: string;
}
export interface ClaimEvaluation {
  citation: CitationStatus | null;
  number: NumberStatus | null;
  date: DateStatus | null;
  link: LinkStatus | null;
  hash: HashStatus | null;
  signature: SignatureStatus | null;
  results: Record<string, string | null>; // 레지스트리 전체 결과(확장 검증기 포함)
  evidence: Record<string, CheckEvidence>; // 실패 check 별 expected/actual(결정론·증명)
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

// ── check 레지스트리 (플러그인 구조 — 아직 VM 아님) ──
// 새 검증기 = descriptor 한 줄 등록. 엔진(evaluateClaim)은 불변. run 이 null 이면 그 주장엔 미적용.
// 정직: 이건 플러그인/레지스트리 디스패치지 VM(DSL·opcode·실행컨텍스트·상태)이 아니다. "VM"은 미래 목표.
// positive=이 검증이 verified 이면 "실증 근거"로 침(link 는 well-formedness 라 positive=false·advisory).
export interface CheckDescriptor {
  kind: string;
  positive: boolean;
  run: (c: EvalClaimInput, source: string | null) => string | null;
}
export const CHECK_REGISTRY: CheckDescriptor[] = [
  { kind: "citation", positive: true, run: (c, s) => (typeof c.quotedText === "string" && c.quotedText ? citationStatus(c.quotedText, s) : null) },
  { kind: "number", positive: true, run: (c, s) => (c.statedValue !== undefined ? numberStatus(parseStated(c.statedValue), { source: s, op: c.op, operands: Array.isArray(c.operands) ? (c.operands as number[]) : undefined, eps: typeof c.eps === "number" ? c.eps : undefined }) : null) },
  { kind: "date", positive: true, run: (c, s) => (c.statedDate !== undefined ? dateStatus(typeof c.statedDate === "string" ? c.statedDate : null, s) : null) },
  { kind: "hash", positive: true, run: (c) => (c.statedHash !== undefined ? hashStatus(typeof c.statedHash === "string" ? c.statedHash : null, typeof c.content === "string" ? c.content : null, typeof c.algo === "string" ? c.algo : "sha256") : null) },
  { kind: "signature", positive: true, run: (c) => (c.signature !== undefined || c.publicKey !== undefined ? signatureStatus(typeof c.content === "string" ? c.content : null, typeof c.signature === "string" ? c.signature : null, typeof c.publicKey === "string" ? c.publicKey : null) : null) },
  { kind: "link", positive: false, run: (c) => (typeof c.link === "string" ? linkStatus(c.link) : null) },
];
export const CHECK_KINDS: string[] = CHECK_REGISTRY.map((d) => d.kind);
const FAILED_STATUSES = new Set(["not-found", "mismatch", "invalid"]);

// 실패 check 의 evidence(expected/actual) 생산 — 결정론(커널이 이미 가진 입력·재계산으로). 추정 없음.
function evidenceFor(c: EvalClaimInput, source: string | null, results: Record<string, string | null>): Record<string, CheckEvidence> {
  const ev: Record<string, CheckEvidence> = {};
  const s = source ?? "";
  if (results.citation === "not-found" && typeof c.quotedText === "string") {
    ev.citation = { expected: c.quotedText, actual: "출처 텍스트에 없음 (not present in source)" };
  }
  if (results.number === "mismatch") {
    const stated = parseStated(c.statedValue);
    let actual = "출처에서 확인 불가";
    if (isNumberOp(c.op) && Array.isArray(c.operands)) {
      const r = recompute(c.op, c.operands as number[]);
      if (r !== null) actual = `재계산 ${String(r)}`;
    } else {
      const nums = parseNumbersFromText(s);
      if (nums.length) actual = `출처의 수치 ${nums.slice(0, 5).join(", ")}`;
    }
    ev.number = { expected: stated !== null ? String(stated) : String(c.statedValue), actual };
  }
  if (results.date === "mismatch" && typeof c.statedDate === "string") {
    const found = datesInText(s);
    ev.date = { expected: canonicalizeDate(c.statedDate) ?? c.statedDate, actual: found.length ? `출처의 날짜 ${found.join(", ")}` : "출처에 날짜 없음" };
  }
  if (results.hash === "mismatch" && typeof c.statedHash === "string" && typeof c.content === "string") {
    const algo = typeof c.algo === "string" ? c.algo : "sha256";
    let actual = "계산 실패";
    try {
      actual = createHash(algo).update(c.content).digest("hex");
    } catch {
      /* 알 수 없는 알고리즘 */
    }
    ev.hash = { expected: c.statedHash.trim().slice(0, 24), actual: actual.slice(0, 24) };
  }
  if (results.signature === "invalid") {
    ev.signature = { expected: "유효한 ed25519 서명", actual: "검증 실패 (does not verify)" };
  }
  if (results.link === "invalid" && typeof c.link === "string") {
    ev.link = { expected: "http(s) URL", actual: c.link };
  }
  return ev;
}

// 표준 포맷의 단일 의미론: 레지스트리를 디스패치해 한 주장의 모든 typed 근거를 판정.
export function evaluateClaim(c: EvalClaimInput, source: string | null): ClaimEvaluation {
  const results: Record<string, string | null> = {};
  let failed = false;
  let positiveVerified = false;
  for (const d of CHECK_REGISTRY) {
    const st = d.run(c, source);
    results[d.kind] = st;
    if (st && FAILED_STATUSES.has(st)) failed = true;
    if (d.positive && st === "verified") positiveVerified = true;
  }
  return {
    citation: (results.citation as CitationStatus) ?? null,
    number: (results.number as NumberStatus) ?? null,
    date: (results.date as DateStatus) ?? null,
    link: (results.link as LinkStatus) ?? null,
    hash: (results.hash as HashStatus) ?? null,
    signature: (results.signature as SignatureStatus) ?? null,
    results,
    evidence: evidenceFor(c, source, results),
    failed,
    verified: !failed && positiveVerified,
  };
}

// Evidence Specification: 레지스트리에서 기계판독 JSON Schema 생성(코드가 곧 스펙 — 남이 채택할 표면).
export function claimSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "agent-receipt Evidence Claim",
    schemaVersion: SCHEMA_VERSION,
    description: "검증 가능한 근거를 담은 주장. 각 typed check 는 결정론·비-LLM. 판단(결론 옳음)은 보증하지 않음.",
    type: "object",
    checkKinds: CHECK_KINDS,
    properties: {
      statement: { type: "string", description: "주장(표시용·미검증)" },
      sourceUrl: { type: "string", description: "출처 URL(provenance·--fetch 시 라이브 대조)" },
      sourceText: { type: "string" },
      sourceFile: { type: "string" },
      quotedText: { type: "string", description: "citation: 출처의 리터럴 부분문자열인가" },
      statedValue: { type: ["number", "string"], description: "number: 출처의 수 또는 재계산과 상등" },
      op: { type: "string", enum: [...NUMBER_OPS] },
      operands: { type: "array", items: { type: "number" } },
      eps: { type: "number" },
      statedDate: { type: "string", description: "date: 출처의 날짜와 형식무관 상등" },
      link: { type: "string", description: "link: URL well-formedness(valid=advisory)" },
      statedHash: { type: "string", description: "hash: content 의 해시와 상등(무결성)" },
      content: { type: "string" },
      algo: { type: "string", enum: [...HASH_ALGOS] },
      signature: { type: "string", description: "signature: content 에 대한 base64 ed25519 서명" },
      publicKey: { type: "string", description: "signature 검증용 PEM(SPKI) 공개키" },
    },
  };
}
