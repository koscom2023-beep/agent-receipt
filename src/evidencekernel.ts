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
export type RangeStatus = "verified" | "mismatch" | "no-basis";

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

const NUMBER_OPS = ["sum", "mean", "product", "diff", "ratio", "percent", "min", "max", "median", "count", "abs", "pow", "mod", "variance", "stddev", "floor", "ceil", "round"] as const;
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
    // R7 추가(전부 params-free·단일 정의·결정론):
    case "median": { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2; }
    case "count": return xs.length;
    case "abs": return Math.abs(xs[0] as number);
    case "pow": return xs.length >= 2 ? (xs[0] as number) ** (xs[1] as number) : null;
    case "mod": return xs.length >= 2 && xs[1] !== 0 ? (xs[0] as number) % (xs[1] as number) : null;
    case "variance": { const mv = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, b) => a + (b - mv) ** 2, 0) / xs.length; } // 모집단(÷n)
    case "stddev": { const ms = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - ms) ** 2, 0) / xs.length); } // 모집단
    case "floor": return Math.floor(xs[0] as number);
    case "ceil": return Math.ceil(xs[0] as number);
    case "round": return Math.round(xs[0] as number); // half-up
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

// stated 수치가 [min, max] 안인가(포함). min/max 하나만 있어도 그 방향만 검사. 재계산 아닌 경계 대조(등급 B).
export function rangeStatus(stated: number | null, min: number | null, max: number | null): RangeStatus {
  if (stated === null || !Number.isFinite(stated)) return "no-basis";
  if (min === null && max === null) return "no-basis";
  if (min !== null && stated < min) return "mismatch";
  if (max !== null && stated > max) return "mismatch";
  return "verified";
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

// ── git 사실 검증 커널 (commit/fileChanged/diffContains · Phase4) ──
// 셋 다 git 조회(IO)가 필요하지만, 커널 불변식(core ↛ surface·순수 유지)은 hash/signature 와 같은 패턴으로
// 지킨다: surface(gitfacts.ts)가 git 을 조회해 사실(불리언/텍스트)을 먼저 계산하고, 커널은 그 사실을
// 결정론 판정만 한다 — 커널 함수 자체는 git 을 몰라도 된다(테스트도 git 없이 가능).

export type CommitStatus = "verified" | "mismatch" | "no-basis";
// resolvedExists: surface 가 미리 조회한 사실. null=조회 불가(레포 없음 등) → no-basis(거짓 판정 없음).
export function commitStatus(claimedCommit: string | null, resolvedExists: boolean | null): CommitStatus {
  if (!claimedCommit) return "no-basis";
  if (resolvedExists === null) return "no-basis";
  return resolvedExists ? "verified" : "mismatch";
}

export type FileChangedStatus = "verified" | "not-found" | "no-basis";
// changedFiles: surface 가 조회한 변경파일 목록(줄바꿈 구분 텍스트). 인용 커널과 같은 부분문자열 판정 재사용.
export function fileChangedStatus(claimedFile: string | null, changedFiles: string | null): FileChangedStatus {
  if (!claimedFile || changedFiles === null) return "no-basis";
  return verifyCitationInText(claimedFile, changedFiles) ? "verified" : "not-found";
}

export type DiffContainsStatus = "verified" | "not-found" | "no-basis";
// diffText: surface 가 조회한 커밋 diff 텍스트. 마찬가지로 부분문자열 판정.
export function diffContainsStatus(claimedText: string | null, diffText: string | null): DiffContainsStatus {
  if (!claimedText || diffText === null) return "no-basis";
  return verifyCitationInText(claimedText, diffText) ? "verified" : "not-found";
}

// ── 스키마 검증 커널 (JSON Schema 서브셋 · 순수 · Phase4) ──
// 지원: type·required·properties(중첩)·enum·items. 미지원 키워드(pattern/format/oneOf 등)는 무시
//   — 선언 안 한 제약은 검증 안 함(거짓 통과·거짓 실패 둘 다 없음. 지원 범위는 claimSchema()에 명시).
export type SchemaStatus = "verified" | "mismatch" | "no-basis";
export interface SchemaMismatch { path: string; reason: string }

function schemaWalk(data: unknown, schema: Record<string, unknown>, path: string, out: SchemaMismatch[]): void {
  if (typeof schema.type === "string") {
    const actual = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
    if (actual !== schema.type) { out.push({ path, reason: `type ${schema.type} 기대 · 실제 ${actual}` }); return; }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => v === data)) {
    out.push({ path, reason: `enum ${JSON.stringify(schema.enum)} 중 하나 기대 · 실제 ${JSON.stringify(data)}` });
  }
  if (schema.type === "object" && data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === "string" && !(key in obj)) out.push({ path: `${path}.${key}`, reason: "required 필드 없음" });
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, unknown>)) {
        if (key in obj && sub && typeof sub === "object") schemaWalk(obj[key], sub as Record<string, unknown>, `${path}.${key}`, out);
      }
    }
  }
  if (schema.type === "array" && Array.isArray(data) && schema.items && typeof schema.items === "object") {
    data.forEach((item, i) => schemaWalk(item, schema.items as Record<string, unknown>, `${path}[${i}]`, out));
  }
}

// 재계산 가능(캐시 아님) — evidenceFor 가 mismatch 상세를 얻을 때 다시 호출.
export function schemaMismatches(data: unknown, schema: unknown): SchemaMismatch[] {
  if (data === undefined || !schema || typeof schema !== "object") return [];
  const out: SchemaMismatch[] = [];
  schemaWalk(data, schema as Record<string, unknown>, "$", out);
  return out;
}
export function schemaStatus(data: unknown, schema: unknown): SchemaStatus {
  if (data === undefined || !schema || typeof schema !== "object") return "no-basis";
  return schemaMismatches(data, schema).length ? "mismatch" : "verified";
}

// ── 버전/의존성 검증 커널 (순수 · Phase4 → Phase5 에서 진짜 범위판정으로 승격) ──
// depMap: surface 가 package.json 등에서 미리 읽어 파싱한 이름→버전 맵. 커널은 순수 대조만.
// v1(동결): 단일 비교자만 — 정확일치 · ^ · ~ · >= · > · <= · < . 부분버전(^3, >=1.2)은 빠진 자리 0 채움.
//   prerelease(-포함)·복합범위(공백 결합·||)·와일드카드(x/*)는 no-basis(거짓판정보다 무판정 — 스펙 명시).
export type VersionStatus = "verified" | "mismatch" | "no-basis";
function stripRangePrefix(v: string): string {
  return v.trim().replace(/^[\^~>=<]+\s*/, "");
}
// "x.y.z" → [x,y,z] (빠진 자리 0). prerelease/빌드메타/비숫자 → null.
export function parseSemver(v: string): [number, number, number] | null {
  const t = v.trim();
  if (t.includes("-") || t.includes("+")) return null; // prerelease/build → 판정 안 함
  const m = t.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
const cmpSemver = (a: [number, number, number], b: [number, number, number]): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// 단일 비교자 range 를 stated 구체버전이 충족하는가. 판정 불가(복합/와일드카드/prerelease) → null.
export function semverSatisfies(stated: string, range: string): boolean | null {
  const v = parseSemver(stated);
  if (!v) return null;
  const r = range.trim();
  if (/[|]|[\s]/.test(r) || /[xX*]/.test(r)) return null; // 복합·와일드카드 → v1 범위 밖
  const m = r.match(/^(\^|~|>=|<=|>|<)?\s*(.+)$/);
  if (!m) return null;
  const op = m[1] ?? "";
  const base = parseSemver(m[2] as string);
  if (!base) return null;
  const c = cmpSemver(v, base);
  switch (op) {
    case "": return c === 0;
    case ">=": return c >= 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    case "<": return c < 0;
    case "~": { // [base, base.minor+1)
      const upper: [number, number, number] = [base[0], base[1] + 1, 0];
      return c >= 0 && cmpSemver(v, upper) < 0;
    }
    case "^": { // npm 규약: 최좌측 非0 자리 고정
      let upper: [number, number, number];
      if (base[0] > 0) upper = [base[0] + 1, 0, 0];
      else if (base[1] > 0) upper = [0, base[1] + 1, 0];
      else upper = [0, 0, base[2] + 1];
      return c >= 0 && cmpSemver(v, upper) < 0;
    }
    default: return null;
  }
}
export function versionStatus(pkg: string | null, claimedVersion: string | null, depMap: Record<string, unknown> | null): VersionStatus {
  if (!pkg || !claimedVersion || !depMap) return "no-basis";
  const actual = depMap[pkg];
  if (typeof actual !== "string") return "no-basis";
  const stated = stripRangePrefix(claimedVersion); // 주장은 구체버전이어야 — 접두 오면 벗김
  const sat = semverSatisfies(stated, actual);
  if (sat === null) {
    // 범위판정 불가 → 구버전 동작(접두 벗긴 문자열 상등)으로 정직 폴백 — 기존 결과 보존.
    return stripRangePrefix(actual) === stated ? "verified" : "no-basis";
  }
  return sat ? "verified" : "mismatch";
}

// ── 파일 실재 검증 커널 (Phase5 · 스펙 Planned 이행) ──
// exists: surface(fs) 사전조회 사실. 존재만 판정 — 내용은 안 읽음(내용 대조는 citation/hash 의 몫).
export type FileStatus = "verified" | "not-found" | "no-basis";
export function fileStatus(statedFile: string | null, exists: boolean | null): FileStatus {
  if (!statedFile) return "no-basis";
  if (exists === null) return "no-basis";
  return exists ? "verified" : "not-found";
}

// ── 영수증 인용 검증 커널 (Phase5 · 스펙 Planned 'replay' 의 이행) ──
// 주장이 인용한 Verification Receipt 가 실재하고 무결(봉인 재계산 일치)한가.
// surface 가 파일을 읽고 기존 replay 함수로 재계산한 *사실*만 커널에 넘긴다(재구현 0·커널 무IO).
// v1 정직 범위: verification-receipt 만 — Work Receipt(schemaVersion 1.0)는 no-basis(미지원 명시).
export interface ReceiptFacts {
  found: boolean; // 파일 존재+파싱 성공
  isVerificationReceipt: boolean;
  contentHashOk: boolean | null;
  receiptIdOk: boolean | null;
  actualReceiptId: string | null;
}
export type ReceiptStatus = "verified" | "mismatch" | "no-basis";
export function receiptStatus(statedReceiptId: string | null, facts: ReceiptFacts | null): ReceiptStatus {
  if (!statedReceiptId || statedReceiptId.trim().length < 8) return "no-basis"; // 접두 8자 미만=모호
  if (facts === null) return "no-basis"; // 인용 파일 미지정
  if (!facts.found) return "mismatch"; // 인용한 영수증이 없음 — citation not-found 와 같은 원칙(인용 정확성은 인용자 책임)
  if (!facts.isVerificationReceipt) return "no-basis"; // v1 미지원 종류 — 거짓판정 대신 무판정
  if (typeof facts.actualReceiptId !== "string" || !facts.actualReceiptId.startsWith(statedReceiptId.trim())) return "mismatch";
  if (facts.contentHashOk !== true || facts.receiptIdOk !== true) return "mismatch"; // 봉인 재계산 불일치=변조
  return "verified";
}

// ── 산출물(artifact) 형태 검증 커널 (Phase6 · 스펙 Planned 'artifact' 이행) ──
// 빌드/테스트 산출물이 주장한 *형태 제약*(크기 경계·sha256)과 정합한가 — 빈/절단 산출물 검출용.
// 보증 정직(DA① 완화): "형태가 제약과 정합"이지 "산출물이 옳다/완전하다" 아님. 강한 보증이 필요하면 sha 제약 병용.
// file(실재만)·hash(내용만)와의 중복 방지: 제약(min/max/sha) ≥1 없으면 no-basis — 경로만으론 판정 안 함.
export interface ArtifactFacts {
  exists: boolean;
  sizeBytes: number | null;
  sha256: string | null; // sha 제약이 있을 때만 surface 가 계산(대용량 기본 회피)
}
export interface ArtifactConstraints {
  minBytes?: number;
  maxBytes?: number;
  sha256?: string;
}
export type ArtifactStatus = "verified" | "not-found" | "mismatch" | "no-basis";
export function artifactStatus(statedArtifact: string | null, c: ArtifactConstraints, facts: ArtifactFacts | null): ArtifactStatus {
  if (!statedArtifact) return "no-basis";
  const hasConstraint = typeof c.minBytes === "number" || typeof c.maxBytes === "number" || (typeof c.sha256 === "string" && c.sha256.length > 0);
  if (!hasConstraint) return "no-basis"; // 경로만=file 체크의 일 — 여긴 형태 제약이 있어야 의미
  if (facts === null) return "no-basis";
  if (!facts.exists) return "not-found";
  if (typeof c.minBytes === "number" && (facts.sizeBytes === null || facts.sizeBytes < c.minBytes)) return "mismatch";
  if (typeof c.maxBytes === "number" && (facts.sizeBytes === null || facts.sizeBytes > c.maxBytes)) return "mismatch";
  if (typeof c.sha256 === "string" && c.sha256) {
    if (typeof facts.sha256 !== "string") return "no-basis"; // 계산 불가 → 무판정(거짓 mismatch 금지)
    if (facts.sha256.toLowerCase() !== c.sha256.trim().toLowerCase()) return "mismatch";
  }
  return "verified";
}

// ── 통합 claim 평가 (표준 포맷의 단일 의미론 — research·council 이 공유) ──
// 코드가 곧 포맷 스펙: 한 주장이 담은 각 typed 근거(인용/수치/날짜/링크)를 한 곳에서 결정론 판정.
export interface EvalClaimInput {
  quotedText?: unknown;
  statedValue?: unknown;
  op?: unknown;
  operands?: unknown;
  eps?: unknown;
  statedMin?: unknown; // range: 하한(포함)
  statedMax?: unknown; // range: 상한(포함)
  statedDate?: unknown;
  link?: unknown; // 형식 검증할 URL(surface 가 sourceUrl 을 넘길 수 있음)
  statedHash?: unknown; // 무결성: content 의 해시가 이것과 일치하나
  content?: unknown; // 해시/서명 대상 콘텐츠(인라인·surface 가 파일에서 채울 수 있음)
  algo?: unknown; // 해시 알고리즘(기본 sha256)
  signature?: unknown; // base64 ed25519 서명(content 에 대한)
  publicKey?: unknown; // PEM(SPKI) 공개키 — 서명 검증용
  statedCommit?: unknown; // commit: 이 해시가 레포에 실재하나(surface 가 조회한 사실을 commitExists 로 넘김)
  commitExists?: unknown; // surface 사전조회 사실(불리언). undefined/null=조회 불가
  statedChangedFile?: unknown; // fileChanged: 이 커밋이 이 파일을 변경했나
  changedFiles?: unknown; // surface 사전조회: 그 커밋의 변경파일 목록(텍스트)
  statedDiffText?: unknown; // diffContains: 그 커밋의 diff 가 이 텍스트를 포함하나
  diffText?: unknown; // surface 사전조회: 그 커밋의 diff 텍스트
  schemaData?: unknown; // schema: 이 데이터가 schemaDef 와 맞나(둘 다 인라인 — IO 불필요)
  schemaDef?: unknown; // JSON Schema 서브셋(claimSchema() 참고 지원 범위)
  statedPackage?: unknown; // version: 이 패키지가
  statedPackageVersion?: unknown; // 이 버전인가
  dependencyMap?: unknown; // surface 사전조회: package.json 등에서 읽은 이름→버전 맵
  statedFile?: unknown; // file: 이 파일이 디스크에 실재하나
  fileExists?: unknown; // surface 사전조회 사실(불리언). undefined/null=조회 불가
  statedReceiptId?: unknown; // receipt: 인용한 영수증 id(접두 ≥8자)
  receiptFacts?: unknown; // surface 사전조회: ReceiptFacts(기존 replay 재계산 결과)
  statedArtifact?: unknown; // artifact: 산출물 경로 — 아래 제약 ≥1 필수(없으면 no-basis)
  artifactMinBytes?: unknown; // 형태 제약: 최소 크기
  artifactMaxBytes?: unknown; // 형태 제약: 최대 크기
  artifactSha256?: unknown; // 형태 제약: 내용 해시
  artifactFacts?: unknown; // surface 사전조회: ArtifactFacts(exists·sizeBytes·sha256[요구 시만])
}
// Evidence = 실패 check 의 *증명*(expected↔actual). reason 은 설명, evidence 는 결정론 비교 근거.
export interface CheckEvidence {
  expected: string;
  actual: string;
}
export interface ClaimEvaluation {
  citation: CitationStatus | null;
  number: NumberStatus | null;
  range: RangeStatus | null;
  date: DateStatus | null;
  link: LinkStatus | null;
  hash: HashStatus | null;
  signature: SignatureStatus | null;
  commit: CommitStatus | null;
  fileChanged: FileChangedStatus | null;
  diffContains: DiffContainsStatus | null;
  schema: SchemaStatus | null;
  version: VersionStatus | null;
  file: FileStatus | null;
  receipt: ReceiptStatus | null;
  artifact: ArtifactStatus | null;
  results: Record<string, string | null>; // 레지스트리 전체 결과(확장 검증기 포함)
  evidence: Record<string, CheckEvidence>; // 실패 check 별 expected/actual(결정론·증명)
  failed: boolean; // 어느 근거든 불일치(not-found/mismatch/invalid)
  verified: boolean; // 실증된 근거 1+ 이고 불일치 0
  assuranceGrade: Grade | null; // R2: 실증된 positive check 중 가장 강한 등급(없으면 null) — 실제 도달한 보증 강도
  abstain: boolean; // R2: 판정 보류 — 실증 근거도 불일치도 없음(no basis·미검증 경계)
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
// 증거 등급(R2·감사 증거 위계): A=커널이 답을 재계산(수치=operands·해시/서명=content — 출처 수치를 안 믿음)
//   · B=resolved 사실/부분문자열 대조(출처·git 진실성에 의존) · C=well-formedness(link). 재계산 > 대조 > 형식.
export type Grade = "A" | "B" | "C";
export const GRADE_RANK: Record<Grade, number> = { A: 3, B: 2, C: 1 };
export interface CheckDescriptor {
  kind: string;
  positive: boolean;
  grade: Grade;
  run: (c: EvalClaimInput, source: string | null) => string | null;
}
export const CHECK_REGISTRY: CheckDescriptor[] = [
  { kind: "citation", positive: true, grade: "B", run: (c, s) => (typeof c.quotedText === "string" && c.quotedText ? citationStatus(c.quotedText, s) : null) },
  { kind: "number", positive: true, grade: "A", run: (c, s) => (c.statedValue !== undefined ? numberStatus(parseStated(c.statedValue), { source: s, op: c.op, operands: Array.isArray(c.operands) ? (c.operands as number[]) : undefined, eps: typeof c.eps === "number" ? c.eps : undefined }) : null) },
  { kind: "range", positive: true, grade: "B", run: (c) => (c.statedValue !== undefined && (c.statedMin !== undefined || c.statedMax !== undefined) ? rangeStatus(parseStated(c.statedValue), parseStated(c.statedMin), parseStated(c.statedMax)) : null) },
  { kind: "date", positive: true, grade: "B", run: (c, s) => (c.statedDate !== undefined ? dateStatus(typeof c.statedDate === "string" ? c.statedDate : null, s) : null) },
  { kind: "hash", positive: true, grade: "A", run: (c) => (c.statedHash !== undefined ? hashStatus(typeof c.statedHash === "string" ? c.statedHash : null, typeof c.content === "string" ? c.content : null, typeof c.algo === "string" ? c.algo : "sha256") : null) },
  { kind: "signature", positive: true, grade: "A", run: (c) => (c.signature !== undefined || c.publicKey !== undefined ? signatureStatus(typeof c.content === "string" ? c.content : null, typeof c.signature === "string" ? c.signature : null, typeof c.publicKey === "string" ? c.publicKey : null) : null) },
  { kind: "link", positive: false, grade: "C", run: (c) => (typeof c.link === "string" ? linkStatus(c.link) : null) },
  { kind: "commit", positive: true, grade: "B", run: (c) => (typeof c.statedCommit === "string" ? commitStatus(c.statedCommit, typeof c.commitExists === "boolean" ? c.commitExists : null) : null) },
  { kind: "fileChanged", positive: true, grade: "B", run: (c) => (typeof c.statedChangedFile === "string" ? fileChangedStatus(c.statedChangedFile, typeof c.changedFiles === "string" ? c.changedFiles : null) : null) },
  { kind: "diffContains", positive: true, grade: "B", run: (c) => (typeof c.statedDiffText === "string" ? diffContainsStatus(c.statedDiffText, typeof c.diffText === "string" ? c.diffText : null) : null) },
  { kind: "schema", positive: true, grade: "B", run: (c) => (c.schemaData !== undefined && c.schemaDef !== undefined ? schemaStatus(c.schemaData, c.schemaDef) : null) },
  { kind: "version", positive: true, grade: "B", run: (c) => (typeof c.statedPackage === "string" ? versionStatus(c.statedPackage, typeof c.statedPackageVersion === "string" ? c.statedPackageVersion : null, c.dependencyMap && typeof c.dependencyMap === "object" ? (c.dependencyMap as Record<string, unknown>) : null) : null) },
  { kind: "file", positive: true, grade: "B", run: (c) => (typeof c.statedFile === "string" ? fileStatus(c.statedFile, typeof c.fileExists === "boolean" ? c.fileExists : null) : null) },
  { kind: "receipt", positive: true, grade: "B", run: (c) => (typeof c.statedReceiptId === "string" ? receiptStatus(c.statedReceiptId, c.receiptFacts && typeof c.receiptFacts === "object" ? (c.receiptFacts as ReceiptFacts) : null) : null) },
  { kind: "artifact", positive: true, grade: "B", run: (c) => (typeof c.statedArtifact === "string" ? artifactStatus(c.statedArtifact, { minBytes: typeof c.artifactMinBytes === "number" ? c.artifactMinBytes : undefined, maxBytes: typeof c.artifactMaxBytes === "number" ? c.artifactMaxBytes : undefined, sha256: typeof c.artifactSha256 === "string" ? c.artifactSha256 : undefined }, c.artifactFacts && typeof c.artifactFacts === "object" ? (c.artifactFacts as ArtifactFacts) : null) : null) },
];
export const CHECK_KINDS: string[] = CHECK_REGISTRY.map((d) => d.kind);
export const CHECK_GRADES: Record<string, Grade> = Object.fromEntries(CHECK_REGISTRY.map((d) => [d.kind, d.grade]));
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
  if (results.range === "mismatch") {
    const stated = parseStated(c.statedValue);
    const lo = parseStated(c.statedMin);
    const hi = parseStated(c.statedMax);
    ev.range = { expected: `[${lo ?? "-∞"}, ${hi ?? "+∞"}]`, actual: stated !== null ? String(stated) : String(c.statedValue) };
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
  if (results.commit === "mismatch" && typeof c.statedCommit === "string") {
    ev.commit = { expected: c.statedCommit, actual: "레포에 이 커밋 없음 (commit not found in repo)" };
  }
  if (results.fileChanged === "not-found" && typeof c.statedChangedFile === "string") {
    const cf = typeof c.changedFiles === "string" ? c.changedFiles : "";
    ev.fileChanged = { expected: c.statedChangedFile, actual: cf ? `그 커밋의 변경파일: ${cf.split("\n").filter(Boolean).slice(0, 5).join(", ")}` : "그 커밋은 파일을 안 바꿈" };
  }
  if (results.diffContains === "not-found" && typeof c.statedDiffText === "string") {
    ev.diffContains = { expected: c.statedDiffText, actual: "그 커밋의 diff 에 없음 (not present in diff)" };
  }
  if (results.schema === "mismatch") {
    const mism = schemaMismatches(c.schemaData, c.schemaDef);
    ev.schema = { expected: "schemaDef 를 만족하는 데이터", actual: mism.map((m) => `${m.path}: ${m.reason}`).join(" · ") };
  }
  if (results.version === "mismatch" && typeof c.statedPackage === "string" && c.dependencyMap && typeof c.dependencyMap === "object") {
    const actual = (c.dependencyMap as Record<string, unknown>)[c.statedPackage];
    ev.version = { expected: String(c.statedPackageVersion), actual: typeof actual === "string" ? actual : "의존성 맵에 없음" };
  }
  if (results.file === "not-found" && typeof c.statedFile === "string") {
    ev.file = { expected: c.statedFile, actual: "디스크에 없음 (file does not exist)" };
  }
  if ((results.artifact === "mismatch" || results.artifact === "not-found") && typeof c.statedArtifact === "string") {
    const f = c.artifactFacts as ArtifactFacts | null | undefined;
    const constraints: string[] = [];
    if (typeof c.artifactMinBytes === "number") constraints.push(`min ${c.artifactMinBytes}B`);
    if (typeof c.artifactMaxBytes === "number") constraints.push(`max ${c.artifactMaxBytes}B`);
    if (typeof c.artifactSha256 === "string") constraints.push(`sha256 ${c.artifactSha256.slice(0, 12)}…`);
    ev.artifact = {
      expected: `${c.statedArtifact} (${constraints.join(" · ")})`,
      actual: !f?.exists ? "산출물 없음 (artifact does not exist)" : `크기 ${f.sizeBytes ?? "?"}B${f.sha256 ? ` · sha256 ${f.sha256.slice(0, 12)}…` : ""}`,
    };
  }
  if (results.receipt === "mismatch" && typeof c.statedReceiptId === "string") {
    const f = c.receiptFacts as ReceiptFacts | null | undefined;
    let actual = "인용한 영수증 파일 없음 (cited receipt not found)";
    if (f?.found) {
      if (typeof f.actualReceiptId === "string" && !f.actualReceiptId.startsWith(c.statedReceiptId.trim())) actual = `실제 receiptId ${f.actualReceiptId.slice(0, 16)}…`;
      else actual = "봉인 재계산 불일치 (replay mismatch — 변조 의심)";
    }
    ev.receipt = { expected: c.statedReceiptId, actual };
  }
  return ev;
}

// 표준 포맷의 단일 의미론: 레지스트리를 디스패치해 한 주장의 모든 typed 근거를 판정.
export function evaluateClaim(c: EvalClaimInput, source: string | null): ClaimEvaluation {
  const results: Record<string, string | null> = {};
  let failed = false;
  let positiveVerified = false;
  let bestGrade: Grade | null = null;
  for (const d of CHECK_REGISTRY) {
    const st = d.run(c, source);
    results[d.kind] = st;
    if (st && FAILED_STATUSES.has(st)) failed = true;
    if (d.positive && st === "verified") {
      positiveVerified = true;
      if (bestGrade === null || GRADE_RANK[d.grade] > GRADE_RANK[bestGrade]) bestGrade = d.grade;
    }
  }
  return {
    citation: (results.citation as CitationStatus) ?? null,
    number: (results.number as NumberStatus) ?? null,
    range: (results.range as RangeStatus) ?? null,
    date: (results.date as DateStatus) ?? null,
    link: (results.link as LinkStatus) ?? null,
    hash: (results.hash as HashStatus) ?? null,
    signature: (results.signature as SignatureStatus) ?? null,
    commit: (results.commit as CommitStatus) ?? null,
    fileChanged: (results.fileChanged as FileChangedStatus) ?? null,
    diffContains: (results.diffContains as DiffContainsStatus) ?? null,
    schema: (results.schema as SchemaStatus) ?? null,
    version: (results.version as VersionStatus) ?? null,
    file: (results.file as FileStatus) ?? null,
    receipt: (results.receipt as ReceiptStatus) ?? null,
    artifact: (results.artifact as ArtifactStatus) ?? null,
    results,
    evidence: evidenceFor(c, source, results),
    failed,
    verified: !failed && positiveVerified,
    assuranceGrade: positiveVerified ? bestGrade : null,
    abstain: !failed && !positiveVerified,
  };
}

// R6: 평가된 복합 주장을 원자 sub-claim 판정으로 분해 — 적용범위 claim→assertion. 재평가 없음(활성 검사만·results!=null).
export interface SubClaim {
  kind: string; // 검사 종류
  positive: boolean; // 실증 근거인가(link 등 well-formedness=false)
  grade: Grade; // R2 증거 등급
  status: string; // 원시 검사 status(verified/not-found/mismatch/...)
  verdict: "verified" | "failed" | "abstain"; // 정규화 3-값
}
export function decomposeClaim(ev: ClaimEvaluation): SubClaim[] {
  const out: SubClaim[] = [];
  for (const d of CHECK_REGISTRY) {
    const st = ev.results[d.kind];
    if (st == null) continue; // 미적용 검사 = 이 주장의 assertion 아님
    const verdict = FAILED_STATUSES.has(st) ? "failed" : st === "verified" ? "verified" : "abstain";
    out.push({ kind: d.kind, positive: d.positive, grade: d.grade, status: st, verdict });
  }
  return out;
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
      statedMin: { type: ["number", "string"], description: "range: 하한(포함)" },
      statedMax: { type: ["number", "string"], description: "range: 상한(포함)" },
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
      statedCommit: { type: "string", description: "commit: 이 해시가 레포에 실재하나(surface 가 git 으로 사전조회)" },
      statedChangedFile: { type: "string", description: "fileChanged: statedCommit 이 이 파일을 변경했나" },
      statedDiffText: { type: "string", description: "diffContains: statedCommit 의 diff 가 이 텍스트를 포함하나" },
      schemaData: { description: "schema: 이 데이터가(임의 JSON 값)" },
      schemaDef: { type: "object", description: "schema: 이 JSON Schema 서브셋(type/required/properties/enum/items)을 만족하나 — 그 외 키워드는 무시" },
      statedPackage: { type: "string", description: "version: 이 패키지명이" },
      statedPackageVersion: { type: "string", description: "이 버전인가(단일 비교자 ^ ~ >= > <= < 범위충족 판정 · prerelease/복합범위=no-basis)" },
      statedFile: { type: "string", description: "file: 이 파일이 디스크에 실재하나(존재만 — 내용 대조는 citation/hash)" },
      statedReceiptId: { type: "string", description: "receipt: 인용한 Verification Receipt 의 id 접두(≥8자) — 실재+봉인 재계산 일치 판정(Work Receipt 는 v1 미지원=no-basis)" },
      statedArtifact: { type: "string", description: "artifact: 산출물 경로 — 형태 제약(artifactMinBytes/MaxBytes/Sha256) ≥1 필수(제약 정합이지 산출물 정당성 보증 아님)" },
      artifactMinBytes: { type: "number" },
      artifactMaxBytes: { type: "number" },
      artifactSha256: { type: "string" },
    },
  };
}
