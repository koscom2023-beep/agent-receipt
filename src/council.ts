import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { evaluateClaim } from "./evidencekernel.js";
import { writeVerificationReceipt, tierProvenance } from "./vreceipt.js";

const line = "─".repeat(56);

// ── Council verify (v1) ──
// 피드백(2026-07-01): Council 의 핵심은 verify 가 아니라 "회의→주장추출→중복제거→모순탐지→결정" 의
//   Decision Compiler 다. 그 컴파일(판단·오케스트레이션)은 소비자 평면(내가 workflow 로 함). 코어가 하는 건
//   컴파일러가 낸 DecisionRecord 를 **검증**하는 것 + append-only DecisionLog 뿐.
// council verify = 각 decision 의 근거 주장(supportingClaim)을 Evidence Kernel(인용 커널)로 대조해
//   decision 이 실재 근거에 묶여 있는지(grounded) 판정한다. 회의 자체는 실행하지 않는다.
// 모순 탐지(contradiction)는 NLP 없이는 가짜 결정론이라 v1 에서 하지 않는다(defer·정직).

interface SupportingClaim {
  statement?: unknown;
  sourceUrl?: unknown;
  quotedText?: unknown;
  sourceText?: unknown;
  sourceFile?: unknown;
  // research 와 같은 표준 포맷 — 근거에 수치·날짜·해시도 가능(Evidence Kernel 공유).
  statedValue?: unknown;
  op?: unknown;
  operands?: unknown;
  eps?: unknown;
  statedDate?: unknown;
  statedHash?: unknown;
  content?: unknown;
  algo?: unknown;
  signature?: unknown;
  publicKey?: unknown;
}
interface Decision {
  id?: unknown;
  statement?: unknown;
  supportingClaims?: unknown;
  dissent?: unknown; // 반대의견(표시만·검증 안 함·append-only 기록 대상)
}
interface DecisionRecord {
  schemaVersion?: unknown;
  question?: unknown;
  decisions?: unknown;
  provenance?: unknown; // 자가보고 계보 — 영수증에 기록·검증 아님
}

export type DecisionGrounding = "grounded" | "ungrounded" | "unsupported";

// 출처 해석(파일 IO — 커널 밖). research 와 동일 shape 이나 surface 간 결합 대신 자기 완결.
function resolveSource(c: SupportingClaim): string | null {
  if (typeof c.sourceText === "string") return c.sourceText;
  if (typeof c.sourceFile === "string") {
    const p = isAbsolute(c.sourceFile) ? c.sourceFile : join(process.cwd(), c.sourceFile);
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

// 한 decision 의 grounding 판정. 근거 주장을 인용 커널로 대조:
//  - 날조 근거(not-found) 1건+ → ungrounded
//  - 검증된 근거 1건+ 이고 날조 0 → grounded
//  - 근거 아예 없음(또는 전부 no-source) → unsupported
export function gradeDecision(dec: Decision): {
  grounding: DecisionGrounding;
  verified: number;
  notFound: number;
  noSource: number;
} {
  const claims: SupportingClaim[] = Array.isArray(dec.supportingClaims)
    ? dec.supportingClaims.filter((c): c is SupportingClaim => !!c && typeof c === "object" && !Array.isArray(c))
    : [];
  let verified = 0;
  let notFound = 0;
  let noSource = 0;
  let anyFailed = false;
  let anyVerified = false;
  for (const c of claims) {
    const url = typeof c.sourceUrl === "string" ? c.sourceUrl : undefined;
    // research 와 동일한 통합 평가(표준 포맷 공유): 인용·수치·날짜·링크를 한 곳에서.
    const ev = evaluateClaim(
      { quotedText: c.quotedText, statedValue: c.statedValue, op: c.op, operands: c.operands, eps: c.eps, statedDate: c.statedDate, link: url, statedHash: c.statedHash, content: typeof c.content === "string" ? c.content : undefined, algo: c.algo, signature: c.signature, publicKey: c.publicKey },
      resolveSource(c),
    );
    // 카운트 필드는 인용 상태 기준(하위호환) — citation null 은 no-source 취급.
    if (ev.citation === "verified") verified++;
    else if (ev.citation === "not-found") notFound++;
    else noSource++;
    if (ev.failed) anyFailed = true;
    if (ev.verified) anyVerified = true;
  }
  const grounding: DecisionGrounding = anyFailed ? "ungrounded" : anyVerified ? "grounded" : "unsupported";
  return { grounding, verified, notFound, noSource };
}

// append-only DecisionLog 한 줄(해시체인) — ledger 형. entryCore 는 호출부가 완성(타임스탬프 포함).
// entryHash = sha256(prevHash + 정렬 JSON(entryCore)). 재정렬/변조/삭제 탐지.
export function appendDecisionLog(logPath: string, entryCore: Record<string, unknown>): { prevHash: string; entryHash: string } {
  let prevHash = "";
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length) {
      try {
        const last = JSON.parse(lines[lines.length - 1] as string) as { entryHash?: unknown };
        if (typeof last.entryHash === "string") prevHash = last.entryHash;
      } catch {
        /* 손상된 마지막 줄은 빈 prevHash 로(체인 검증이 이후 잡음) */
      }
    }
  }
  const payload = prevHash + JSON.stringify(entryCore, Object.keys(entryCore).sort());
  const entryHash = createHash("sha256").update(payload).digest("hex");
  appendFileSync(logPath, JSON.stringify({ ...entryCore, prevHash, entryHash }) + "\n");
  return { prevHash, entryHash };
}

/**
 * `agent-receipt council verify --file <decision.json> [--log <path>]`
 *  - 파일 없음/파싱 실패 → exit 2
 *  - 날조 근거를 가진 결정(ungrounded) 1건+ → exit 1
 *  - 전부 grounded/unsupported(날조 없음) → exit 0
 *  --log 지정 시 검증 결과를 append-only DecisionLog(해시체인)에 적립.
 */
export function runCouncilVerify(fileArg: string | undefined, logArg: string | undefined, outArg?: string | undefined): never {
  if (!fileArg) {
    console.error("council verify: --file <path> 가 필요합니다 (DecisionRecord JSON).");
    process.exit(2);
  }
  const p = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    console.error(`council: 파일을 못 읽음: ${fileArg}`);
    process.exit(2);
  }
  let record: DecisionRecord;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    record = parsed as DecisionRecord;
  } catch {
    console.error(`council: JSON 파싱 실패: ${fileArg}`);
    process.exit(2);
  }

  const decisions: Decision[] = Array.isArray(record.decisions)
    ? record.decisions.filter((d): d is Decision => !!d && typeof d === "object" && !Array.isArray(d))
    : [];
  const question = typeof record.question === "string" ? record.question : "(question 없음)";

  console.log("");
  console.log(line);
  console.log(`council 검증: ${question}  (결정 ↔ 근거 대조 · 결정론)`);
  console.log(line);

  let grounded = 0;
  let ungrounded = 0;
  let unsupported = 0;
  const logDecisions: Array<{ statement: string; grounding: DecisionGrounding }> = [];
  let dissentTotal = 0;

  decisions.forEach((dec, i) => {
    const stmt = typeof dec.statement === "string" ? dec.statement : "(statement 없음)";
    const { grounding, verified, notFound, noSource } = gradeDecision(dec);
    const dissent: string[] = Array.isArray(dec.dissent) ? dec.dissent.filter((x): x is string => typeof x === "string") : [];
    dissentTotal += dissent.length;
    if (grounding === "grounded") grounded++;
    else if (grounding === "ungrounded") ungrounded++;
    else unsupported++;
    logDecisions.push({ statement: stmt, grounding });

    console.log(`[${i + 1}] ${stmt}`);
    console.log(`    근거 : verified ${verified} · not-found ${notFound} · no-source ${noSource}`);
    if (grounding === "grounded") console.log("    ✓ grounded — 근거 주장이 출처에 실재");
    else if (grounding === "ungrounded") console.log("    ✗ ungrounded — 날조된 근거(출처에 없음) 포함");
    else console.log("    · unsupported — 검증된 근거 없음(advisory)");
    for (const d of dissent) console.log(`    ⟂ dissent(표시만·검증 안 함): ${d}`);
  });
  if (decisions.length === 0) console.log("(검증할 결정 없음)");

  let logNote = "";
  if (logArg) {
    const lp = isAbsolute(logArg) ? logArg : join(process.cwd(), logArg);
    const { entryHash } = appendDecisionLog(lp, {
      timestamp: new Date().toISOString(),
      question,
      decisions: logDecisions,
      dissentCount: dissentTotal,
    });
    logNote = `  DecisionLog 적립: ${logArg} (entryHash ${entryHash.slice(0, 12)}…·해시체인)`;
  }

  console.log(line);
  console.log(`결과: grounded ${grounded} · ungrounded ${ungrounded} · unsupported ${unsupported}`);
  console.log(
    ungrounded
      ? `  ❌ 날조 근거를 가진 결정 ${ungrounded}건 — 이 결정들의 근거는 출처에 없음`
      : "  ✅ 날조된 근거 없음 (unsupported 는 근거 미제출·미검증)",
  );
  if (logNote) console.log(logNote);
  console.log("  보증 범위: 결정이 제출한 근거가 출처에 실재하나(근거 충실성)이지 결정이 옳으냐가 아님. 회의 실행·모순탐지는 코어 밖.");
  if (outArg) {
    const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
    const { receiptId, contentHash } = writeVerificationReceipt(outP, {
      surface: "council",
      inputFile: fileArg ?? "(input)",
      inputRaw: raw,
      subject: question,
      provenance: tierProvenance(record.provenance),
      results: logDecisions,
      summary: { grounded, ungrounded, unsupported },
      verdict: ungrounded ? "fail" : "pass",
      verifiedAt: new Date().toISOString(),
    });
    console.log(`  📄 Verification Receipt: ${outArg} (receiptId ${receiptId.slice(0, 12)}…·contentHash ${contentHash.slice(0, 12)}…·provenance verified/reported 분리·증적≠증명)`);
  }
  console.log(line);
  console.log("");
  process.exit(ungrounded ? 1 : 0);
}
