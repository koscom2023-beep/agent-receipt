import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  normalizeForCitation, verifyCitationInText, citationStatus, type CitationStatus,
  evaluateClaim, claimFingerprintV1,
} from "./evidencekernel.js";
import { writeVerificationReceipt, tierProvenance } from "./vreceipt.js";
import { resolveCommitExists, resolveChangedFiles, resolveDiffText, resolveDependencyMap, resolveFileExists, resolveReceiptFacts, resolveArtifactFacts } from "./gitfacts.js";
import type { ReceiptFacts, ArtifactFacts } from "./evidencekernel.js";

// 인용/수치 검증 커널은 공유 Evidence Kernel(evidencekernel.ts)에 있다(research·council 이 같은 코어 재사용).
// 여기선 그 커널을 파일 IO(출처 스냅샷)·라이브 fetch·CLI 출력에 엮는 surface 만 담당한다.
// 하위호환: 커널 함수를 재export(기존 test/외부 소비 불변).
export { normalizeForCitation, verifyCitationInText, citationStatus };
export type { CitationStatus };

const line = "─".repeat(56);

// ── Research 인용 검증 (v1, offline) ──
// 회의 결론(2차): research 의 유일한 비복제 차별점은 오케스트레이션(검색=커모디티·프롬프트로 복제됨)이
//   아니라 "인용이 출처에 실제로 있는가"를 모델 밖 결정론 코드로 대조하는 것 = Claim≠Observation.
// v1 = offline: quotedText 가 제공된 출처(인라인 sourceText 또는 로컬 스냅샷 sourceFile)의 리터럴
//   부분문자열인지 pass/fail. 라이브 URL 재-fetch 는 v2(anchor 처럼 명시 게이트).
// 보증 범위(정직·좁게): "인용 충실성"(인용문이 그 출처에 실재하나)이지 "진위"(주장이 옳나)가 아니다.

// ResearchReport 계약(v1) — 필드는 방어적으로 unknown 으로 받고 타입 확인 후 사용.
interface ResearchClaim {
  id?: unknown;
  statement?: unknown; // 주장(표시용)
  sourceUrl?: unknown; // 출처 URL — provenance 라벨 · --fetch 시 라이브 대조 대상
  quotedText?: unknown; // 주장이 기대는 원문 인용(검증 대상)
  sourceText?: unknown; // 인라인 출처 스냅샷
  sourceFile?: unknown; // 또는 로컬 출처 스냅샷 파일 경로
  // 수치 검증(선택) — statedValue 있으면 수치 커널로 대조.
  statedValue?: unknown; // 주장이 명시한 수(모드A: 출처에 실재 / 모드B: op+operands 재계산과 상등)
  op?: unknown; // 재계산 연산(sum|mean|product|diff|ratio|percent|min|max)
  operands?: unknown; // 재계산 피연산자(report 가 줌·발명 0)
  eps?: unknown; // 허용오차(기본 1e-9)
  statedDate?: unknown; // 날짜 검증(선택) — 출처의 날짜와 형식무관 대조
  statedHash?: unknown; // 무결성 검증(선택) — content/contentFile 의 해시가 이것과 일치하나
  content?: unknown; // 해시/서명 대상 콘텐츠(인라인)
  contentFile?: unknown; // 또는 로컬 파일(surface 가 읽어 해시/서명)
  algo?: unknown; // 해시 알고리즘(기본 sha256)
  signature?: unknown; // 서명 검증(선택) — content 에 대한 base64 ed25519 서명
  publicKey?: unknown; // PEM 공개키
  // git 사실 검증(선택, Phase4) — surface 가 git 조회(IO) 후 커널에 사실만 넘김.
  statedCommit?: unknown; // 이 커밋해시가 레포에 실재하나
  statedChangedFile?: unknown; // statedCommit 이 이 파일을 변경했나
  statedDiffText?: unknown; // statedCommit 의 diff 가 이 텍스트를 포함하나(파일은 statedChangedFile 사용)
  repoDir?: unknown; // git 조회 대상 레포(기본: process.cwd())
  // 스키마 검증(선택, Phase4) — 둘 다 인라인(IO 불필요).
  schemaData?: unknown;
  schemaDef?: unknown;
  // 버전/의존성 검증(선택, Phase4).
  statedPackage?: unknown;
  statedPackageVersion?: unknown;
  dependencyFile?: unknown; // package.json 등 경로(surface 가 읽어 이름→버전 맵으로 파싱)
  statedFile?: unknown; // file 검증(선택, Phase5) — 이 파일이 실재하나(존재만)
  statedReceiptId?: unknown; // receipt 검증(선택, Phase5) — 인용한 영수증 id 접두(≥8자)
  receiptFile?: unknown; // 인용한 영수증 파일 경로(surface 가 읽어 replay 재계산)
  statedArtifact?: unknown; // artifact 검증(선택, Phase6) — 산출물 경로+형태 제약 ≥1
  artifactMinBytes?: unknown;
  artifactMaxBytes?: unknown;
  artifactSha256?: unknown;
}
interface ResearchReport {
  schemaVersion?: unknown;
  query?: unknown;
  claims?: unknown;
  provenance?: unknown; // 자가보고 계보(model/prompt/inputFiles/commit/tests) — 영수증에 기록·검증 아님
}

// 출처 해석: 인라인 sourceText 우선, 없으면 로컬 sourceFile 읽기(파일 IO 는 커널 밖). 둘 다 없거나 못 읽으면 null.
export function resolveSource(claim: ResearchClaim): string | null {
  if (typeof claim.sourceText === "string") return claim.sourceText;
  if (typeof claim.sourceFile === "string") {
    const p = isAbsolute(claim.sourceFile) ? claim.sourceFile : join(process.cwd(), claim.sourceFile);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

// 한 주장의 인용 상태 판정. 출처를 IO 로 해석한 뒤 순수 커널(citationStatus)에 위임.
export function checkClaimCitation(claim: ResearchClaim): CitationStatus {
  const quote = typeof claim.quotedText === "string" ? claim.quotedText : "";
  return citationStatus(quote, resolveSource(claim));
}

// 해시 대상 콘텐츠 해석(파일 IO 는 커널 밖): 인라인 content 우선, 없으면 contentFile 읽기.
function resolveContent(claim: ResearchClaim): string | undefined {
  if (typeof claim.content === "string") return claim.content;
  if (typeof claim.contentFile === "string") {
    const p = isAbsolute(claim.contentFile) ? claim.contentFile : join(process.cwd(), claim.contentFile);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// git/의존성 사실 사전조회(파일 IO·git 프로세스 실행은 커널 밖) — 필요한 필드가 있을 때만 조회.
interface ResolvedFacts {
  commitExists?: boolean | null;
  changedFiles?: string | null;
  diffText?: string | null;
  dependencyMap?: Record<string, string> | null;
  fileExists?: boolean | null;
  receiptFacts?: ReceiptFacts | null;
  artifactFacts?: ArtifactFacts | null;
}
function resolveFacts(claim: ResearchClaim): ResolvedFacts {
  const facts: ResolvedFacts = {};
  const repoDir = typeof claim.repoDir === "string" && claim.repoDir ? claim.repoDir : process.cwd();
  if (typeof claim.statedCommit === "string" && claim.statedCommit) {
    facts.commitExists = resolveCommitExists(claim.statedCommit, repoDir);
    if (typeof claim.statedChangedFile === "string" && claim.statedChangedFile) facts.changedFiles = resolveChangedFiles(claim.statedCommit, repoDir);
    if (typeof claim.statedDiffText === "string" && claim.statedDiffText && typeof claim.statedChangedFile === "string") facts.diffText = resolveDiffText(claim.statedCommit, claim.statedChangedFile, repoDir);
  }
  if (typeof claim.dependencyFile === "string" && claim.dependencyFile) {
    const p = isAbsolute(claim.dependencyFile) ? claim.dependencyFile : join(process.cwd(), claim.dependencyFile);
    facts.dependencyMap = resolveDependencyMap(p);
  }
  if (typeof claim.statedFile === "string" && claim.statedFile) {
    const p = isAbsolute(claim.statedFile) ? claim.statedFile : join(process.cwd(), claim.statedFile);
    facts.fileExists = resolveFileExists(p);
  }
  if (typeof claim.receiptFile === "string" && claim.receiptFile) {
    const p = isAbsolute(claim.receiptFile) ? claim.receiptFile : join(process.cwd(), claim.receiptFile);
    facts.receiptFacts = resolveReceiptFacts(p);
  }
  if (typeof claim.statedArtifact === "string" && claim.statedArtifact) {
    const p = isAbsolute(claim.statedArtifact) ? claim.statedArtifact : join(process.cwd(), claim.statedArtifact);
    facts.artifactFacts = resolveArtifactFacts(p, typeof claim.artifactSha256 === "string" && claim.artifactSha256.length > 0);
  }
  return facts;
}

// ── Markdown 입력 어댑터 (동결 문법 — EVIDENCE_SPEC 에 명시·NLP 0·정규식만) ──
// 문법: 첫 `# <text>` 줄 = query · `- statement: <text>` 가 주장 시작 · 이어지는 들여쓴
//   `key: value` 줄이 그 주장의 필드(JSON 과 같은 키 이름 1:1 — 번역표 없음) ·
//   value 양끝 큰따옴표는 벗김 · operands 는 콤마 구분 숫자 목록 · 그 외 줄은 무시.
// 주장 0건 = 파싱 실패로 취급(호출부가 exit 2) — 조용한 빈 결과 금지.
export function parseMarkdownReport(md: string): { query: string; claims: Record<string, unknown>[] } {
  let query = "";
  const claims: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^#\s+(.*)$/);
    if (h && !query) { query = (h[1] as string).trim(); continue; }
    const start = line.match(/^-\s+statement:\s*(.*)$/);
    if (start) {
      cur = { statement: stripQuotes((start[1] as string).trim()) };
      claims.push(cur);
      continue;
    }
    if (cur) {
      const kv = line.match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
      if (kv) {
        const key = kv[1] as string;
        const rawVal = stripQuotes((kv[2] as string).trim());
        if (key === "operands") {
          cur[key] = rawVal.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
        } else if (key === "statedValue" || key === "eps") {
          const n = Number(rawVal.replace(/,/g, ""));
          cur[key] = Number.isFinite(n) ? n : rawVal;
        } else {
          cur[key] = rawVal;
        }
        continue;
      }
      if (line.trim() === "") cur = null; // 빈 줄 = 주장 블록 종료
    }
  }
  return { query, claims };
}
const stripQuotes = (s: string): string => (s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

// HTML → 텍스트(라이브 fetch 대조용). script/style 제거·태그 제거·기본 엔티티 디코드(공백 정규화는 커널이).
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// 라이브 출처 fetch(--fetch) — 네트워크. 실패/비200/타임아웃 → null(unreachable=링크로트).
// tsc lib 의존을 피하려 globalThis 로 fetch/AbortController 접근(런타임 Node18+ 보장).
async function fetchSource(url: string, timeoutMs = 12000): Promise<string | null> {
  const g = globalThis as {
    fetch?: (u: string, o?: unknown) => Promise<{ ok: boolean; text: () => Promise<string> }>;
    AbortController?: new () => { signal: unknown; abort: () => void };
  };
  if (typeof g.fetch !== "function") return null;
  try {
    const ctl = g.AbortController ? new g.AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await g.fetch(url, ctl ? { signal: ctl.signal, redirect: "follow" } : { redirect: "follow" });
    if (t) clearTimeout(t);
    if (!res.ok) return null;
    return stripHtml(await res.text());
  } catch {
    return null;
  }
}

/**
 * `agent-receipt research verify --file <report.json> [--fetch]` — 각 주장의 인용·수치를 출처와 결정론 대조.
 *  - 파일 없음/파싱 실패 → exit 2
 *  - 날조 인용(not-found) 또는 수치 불일치(mismatch) 1건+ → exit 1
 *  - 전부 통과(또는 대조할 것 없음) → exit 0
 *  --fetch: sourceUrl 을 라이브 재-fetch 해 그 텍스트로 대조(독립 출처·네트워크). 실패 시 unreachable.
 */
export async function runResearchVerify(
  fileArg: string | undefined,
  opts: { fetch?: boolean; out?: string } = {},
): Promise<never> {
  if (!fileArg) {
    console.error("research verify: --file <path> 가 필요합니다 (ResearchReport JSON).");
    process.exit(2);
  }
  const p = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    console.error(`research: 파일을 못 읽음: ${fileArg}`);
    process.exit(2);
  }
  let report: ResearchReport;
  if (/\.(md|markdown)$/i.test(fileArg)) {
    // Markdown 입력(동결 문법) — 같은 내용이면 JSON 과 판정 동일(동형성 테스트로 고정).
    const parsed = parseMarkdownReport(raw);
    if (parsed.claims.length === 0) {
      console.error(`research: 마크다운에서 주장 0건: ${fileArg} — 문법: '# <query>' + '- statement: <주장>' + 들여쓴 'key: value' (spec 참고)`);
      process.exit(2);
    }
    report = { query: parsed.query || "(query 없음)", claims: parsed.claims };
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      report = parsed as ResearchReport;
    } catch {
      console.error(`research: JSON 파싱 실패: ${fileArg}`);
      process.exit(2);
    }
  }

  const claims: ResearchClaim[] = Array.isArray(report.claims)
    ? report.claims.filter((c): c is ResearchClaim => !!c && typeof c === "object" && !Array.isArray(c))
    : [];

  console.log("");
  console.log(line);
  const mode = opts.fetch ? "인용/수치 vs 라이브 출처 · 결정론 · ⚠ 네트워크" : "인용/수치 vs 출처 · 결정론";
  console.log(`research 검증: ${typeof report.query === "string" ? report.query : "(query 없음)"}  (${mode})`);
  console.log(line);

  let failed = 0; // not-found 인용 or mismatch 수치
  let ok = 0; // 검증 통과(인용/수치 중 하나 이상 verified·fail 없음)
  let advisory = 0; // 검증할 근거 없음
  let unreachable = 0; // --fetch 시 출처 도달 실패
  const collected: Array<Record<string, unknown>> = []; // --out 영수증용 claim별 결과

  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i] as ResearchClaim;
    const stmt = typeof claim.statement === "string" ? claim.statement : "(statement 없음)";
    const url = typeof claim.sourceUrl === "string" ? claim.sourceUrl : "";
    const quote = typeof claim.quotedText === "string" ? claim.quotedText : "";

    // 출처 해석: --fetch 면 라이브, 아니면 offline 스냅샷/인라인.
    let source: string | null;
    let fetchNote = "";
    let fetched: { url: string; textSha256: string } | null = null; // Phase9: 표류감지용 — 대조에 쓴 그 텍스트(strip 후) 해시를 봉인
    if (opts.fetch && url) {
      source = await fetchSource(url);
      if (source === null) {
        unreachable++;
        fetchNote = " (⚠ unreachable — 링크로트/차단)";
      } else {
        fetched = { url, textSha256: createHash("sha256").update(source).digest("hex") };
      }
    } else {
      source = resolveSource(claim);
    }

    // git/의존성 사실 사전조회(claim 이 요구할 때만·IO 는 여기서 끝) → 커널엔 사실만 전달.
    const facts = resolveFacts(claim);
    // 통합 평가(표준 포맷의 단일 의미론) — 인용·수치·날짜·링크·해시·commit·fileChanged·diffContains·schema·version 을 한 곳에서.
    const ev = evaluateClaim(
      {
        quotedText: claim.quotedText, statedValue: claim.statedValue, op: claim.op, operands: claim.operands, eps: claim.eps, statedDate: claim.statedDate, link: url || undefined, statedHash: claim.statedHash, content: resolveContent(claim), algo: claim.algo, signature: claim.signature, publicKey: claim.publicKey,
        statedCommit: claim.statedCommit, commitExists: facts.commitExists ?? null,
        statedChangedFile: claim.statedChangedFile, changedFiles: facts.changedFiles ?? null,
        statedDiffText: claim.statedDiffText, diffText: facts.diffText ?? null,
        schemaData: claim.schemaData, schemaDef: claim.schemaDef,
        statedPackage: claim.statedPackage, statedPackageVersion: claim.statedPackageVersion, dependencyMap: facts.dependencyMap ?? null,
        statedFile: claim.statedFile, fileExists: facts.fileExists ?? null,
        statedReceiptId: claim.statedReceiptId, receiptFacts: facts.receiptFacts ?? null,
        statedArtifact: claim.statedArtifact, artifactMinBytes: claim.artifactMinBytes, artifactMaxBytes: claim.artifactMaxBytes, artifactSha256: claim.artifactSha256, artifactFacts: facts.artifactFacts ?? null,
      },
      source,
    );
    if (ev.failed) failed++;
    else if (ev.verified) ok++;
    else advisory++;
    // fingerprint: 시간축 동일성 키(커널 SSOT·additive) — graph/history/diff 가 같은 함수로 재현 가능.
    const fingerprint = claimFingerprintV1({
      statement: stmt,
      sourceUrl: url || null,
      checkKinds: Object.entries(ev.results).filter(([, v]) => v != null).map(([k]) => k),
    });
    collected.push({ statement: stmt, sourceUrl: url || null, fingerprint, checks: ev.results, evidence: ev.evidence, verdict: ev.failed ? "failed" : ev.verified ? "verified" : "advisory", ...(fetched ? { fetched } : {}) });

    console.log(`[${i + 1}] ${stmt}`);
    if (url) console.log(`    출처 : ${url}${fetchNote}${ev.link ? ` [link ${ev.link}]` : ""}`);
    if (quote) console.log(`    인용 : ${quote.length > 72 ? quote.slice(0, 69) + "..." : quote}  → ${ev.citation}`);
    if (claim.statedValue !== undefined) console.log(`    수치 : ${String(claim.statedValue)}${claim.op ? ` (재계산 ${String(claim.op)})` : ""}  → ${ev.number}`);
    if (claim.statedDate !== undefined) console.log(`    날짜 : ${String(claim.statedDate)}  → ${ev.date}`);
    if (claim.statedHash !== undefined) console.log(`    해시 : ${String(claim.statedHash).slice(0, 20)}…  → ${ev.hash}`);
    if (claim.signature !== undefined || claim.publicKey !== undefined) console.log(`    서명 : ed25519  → ${ev.signature}`);
    if (typeof claim.statedCommit === "string") console.log(`    commit : ${claim.statedCommit.slice(0, 12)}…  → ${ev.commit}`);
    if (typeof claim.statedChangedFile === "string") console.log(`    변경파일 : ${claim.statedChangedFile}  → ${ev.fileChanged}`);
    if (typeof claim.statedDiffText === "string") console.log(`    diff 포함 : ${claim.statedDiffText.length > 50 ? claim.statedDiffText.slice(0, 47) + "..." : claim.statedDiffText}  → ${ev.diffContains}`);
    if (claim.schemaData !== undefined && claim.schemaDef !== undefined) console.log(`    스키마 : → ${ev.schema}`);
    if (typeof claim.statedPackage === "string") console.log(`    버전 : ${claim.statedPackage}@${String(claim.statedPackageVersion)}  → ${ev.version}`);
    if (typeof claim.statedFile === "string") console.log(`    파일 : ${claim.statedFile}  → ${ev.file}`);
    if (typeof claim.statedReceiptId === "string") console.log(`    영수증 : ${String(claim.statedReceiptId).slice(0, 12)}…  → ${ev.receipt}`);
    if (typeof claim.statedArtifact === "string") console.log(`    산출물 : ${claim.statedArtifact}  → ${ev.artifact}`);
    console.log(
      ev.failed
        ? "    ✗ FAIL — 근거가 출처와 불일치(날조/수치·날짜오류)"
        : ev.verified
          ? "    ✓ verified — 근거가 출처와 정합"
          : "    · advisory — 검증할 근거 없음(미검증)",
    );
  }
  if (claims.length === 0) console.log("(검증할 주장 없음)");

  console.log(line);
  console.log(`결과: verified ${ok} · FAIL ${failed} · advisory ${advisory}${opts.fetch ? ` · unreachable ${unreachable}` : ""}`);
  console.log(
    failed
      ? `  ❌ 불일치 ${failed}건 — 인용이 출처에 없거나 수치가 재계산/출처와 다름`
      : "  ✅ 불일치 없음 (advisory 는 근거 미제출·미검증)",
  );
  console.log("  보증 범위: 근거가 출처/재계산과 정합하나(충실성)이지 진위(주장이 옳나) 아님." + (opts.fetch ? "" : " 라이브 대조=--fetch."));
  if (opts.out) {
    const outP = isAbsolute(opts.out) ? opts.out : join(process.cwd(), opts.out);
    const { receiptId, contentHash } = writeVerificationReceipt(outP, {
      surface: "research",
      inputFile: fileArg,
      inputRaw: raw,
      subject: typeof report.query === "string" ? report.query : "(query 없음)",
      provenance: tierProvenance(report.provenance),
      results: collected,
      summary: opts.fetch ? { verified: ok, failed, advisory, unreachable } : { verified: ok, failed, advisory },
      verdict: failed ? "fail" : "pass",
      verifiedAt: new Date().toISOString(),
    });
    console.log(`  📄 Verification Receipt: ${opts.out} (receiptId ${receiptId.slice(0, 12)}…·contentHash ${contentHash.slice(0, 12)}…·provenance verified/reported 분리·증적≠증명)`);
  }
  console.log(line);
  console.log("");
  process.exit(failed ? 1 : 0);
}
