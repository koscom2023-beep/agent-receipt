import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { normalizeForCitation, verifyCitationInText, citationStatus, type CitationStatus } from "./evidencekernel.js";

// 인용 검증 커널은 공유 Evidence Kernel(evidencekernel.ts)로 이동했다(피드백: research·council 이 같은 코어 재사용).
// 여기선 그 커널을 파일 IO(출처 스냅샷 읽기)와 CLI 출력에 엮는 surface 만 담당한다.
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
  sourceUrl?: unknown; // 출처 URL — provenance 라벨(표시용·검증은 텍스트로)
  quotedText?: unknown; // 주장이 기대는 원문 인용(검증 대상)
  sourceText?: unknown; // 인라인 출처 스냅샷
  sourceFile?: unknown; // 또는 로컬 출처 스냅샷 파일 경로
}
interface ResearchReport {
  schemaVersion?: unknown;
  query?: unknown;
  claims?: unknown;
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

/**
 * `agent-receipt research verify --file <report.json>` — ResearchReport 의 각 인용을 출처와 결정론 대조.
 *  - 파일 없음/파싱 실패 → exit 2
 *  - 날조 인용(출처에 없음) 1건+ → exit 1
 *  - 전부 검증(또는 대조할 인용 없음) → exit 0
 *  no-source(검증할 출처 없음)는 advisory — 실패로 세지 않되 표시(claims 의 self-report 취급과 동형).
 */
export function runResearchVerify(fileArg: string | undefined): never {
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
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    report = parsed as ResearchReport;
  } catch {
    console.error(`research: JSON 파싱 실패: ${fileArg}`);
    process.exit(2);
  }

  const claims: ResearchClaim[] = Array.isArray(report.claims)
    ? report.claims.filter((c): c is ResearchClaim => !!c && typeof c === "object" && !Array.isArray(c))
    : [];

  console.log("");
  console.log(line);
  console.log(`research 인용검증: ${typeof report.query === "string" ? report.query : "(query 없음)"}  (인용 vs 출처 · 결정론)`);
  console.log(line);

  let verified = 0;
  let notFound = 0;
  let noSource = 0;
  claims.forEach((claim, i) => {
    const status = checkClaimCitation(claim);
    const stmt = typeof claim.statement === "string" ? claim.statement : "(statement 없음)";
    const url = typeof claim.sourceUrl === "string" ? claim.sourceUrl : "(출처 URL 없음)";
    const quote = typeof claim.quotedText === "string" ? claim.quotedText : "";
    console.log(`[${i + 1}] ${stmt}`);
    console.log(`    출처 : ${url}`);
    console.log(`    인용 : ${quote.length > 80 ? quote.slice(0, 77) + "..." : quote}`);
    if (status === "verified") {
      verified++;
      console.log("    ✓ verified — 인용문이 출처에 실재");
    } else if (status === "not-found") {
      notFound++;
      console.log("    ✗ not-found — 인용문이 출처에 없음(날조 가능)");
    } else {
      noSource++;
      console.log("    · no-source — 검증할 출처 없음(advisory·미검증)");
    }
  });
  if (claims.length === 0) console.log("(검증할 인용 없음)");

  console.log(line);
  console.log(`결과: verified ${verified} · not-found ${notFound} · no-source ${noSource}`);
  console.log(
    notFound
      ? `  ❌ 날조 인용 ${notFound}건 — 이 인용문들은 출처에 없음`
      : "  ✅ 검증된 인용은 전부 출처에 실재 (no-source 는 미검증)",
  );
  console.log("  보증 범위: 인용 충실성(인용문이 출처에 있나)이지 진위(주장이 옳나) 아님. 라이브 URL 재-fetch = v2.");
  console.log(line);
  console.log("");
  process.exit(notFound ? 1 : 0);
}
