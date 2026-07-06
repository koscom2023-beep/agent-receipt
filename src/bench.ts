// R1 벤치 하네스 — 라벨된 주장셋에서 결정론 검사기의 정밀·재현율 + N회 재현성(reproducibility)을 측정.
//
// 정직한 범위(회의 D1/D3/D7):
//  - 라벨(expected)은 인간 grounding gold(객관 근거: 커밋이 실재하나·인용이 부분문자열이나=코드 밖에서 참/거짓이 정해짐)
//    이지 주관 판정이 아니다. LLM-eval 의 주관 rigging 과 다르다.
//  - 이 시드셋 정확도는 **표본내·표본력 없음** — "세계 정확도" 주장이 아니다. 외부 공개셋(CiteAudit 등)은 같은 입력 문법으로 후속.
//  - LLM-judge 와의 정확도 비교는 v1 범위 밖(비결정·API). bench 는 **재현성**만 대비 주장한다(같은 입력→같은 판정).
//  - 재현성 100% 는 순수함수라 자명하지만, bench 는 그걸 **측정·게이트**한다 — 미래에 비결정성(Date.now·랜덤·맵순서·
//    부동소수)이 검사기에 스며들면 exit 1 로 CI 가 막는다. 성과가 아니라 **불변식 회귀가드**.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { evaluateOfflineClaim, parseMarkdownReport, type ResearchClaim } from "./research.js";
import { claimFingerprintV1, GRADE_LABELS, type ClaimEvaluation, type Grade } from "./evidencekernel.js";
import { writeVerificationReceipt, tierProvenance } from "./vreceipt.js";

export type Verdict = "verified" | "failed" | "advisory";
export interface BenchClaim extends ResearchClaim {
  expected?: unknown; // gold 라벨: verified | failed | advisory (없으면 재현성만 측정·정확도 제외)
}

const isVerdict = (v: unknown): v is Verdict => v === "verified" || v === "failed" || v === "advisory";

// ClaimEvaluation → 3-값 verdict(코어 의미론 그대로: 불일치=failed·실증 근거+무결=verified·나머지=advisory).
export function verdictOf(ev: ClaimEvaluation): Verdict {
  return ev.failed ? "failed" : ev.verified ? "verified" : "advisory";
}

export interface ClaimScore {
  statement: string;
  expected: Verdict | null; // gold(없으면 null → 정확도 제외)
  predicted: Verdict; // 검사기 출력(1회차)
  runs: number; // 재현성 반복 횟수
  identical: boolean; // runs 회 전부 (판정+지문) 동일 = 재현
  correct: boolean | null; // expected 있을 때만
  fingerprint: string; // 시간축 동일성 키(커널 SSOT)
  assuranceGrade: Grade | null; // R2: 실증된 positive check 중 최강 등급(없으면 null)
}

// 한 주장을 repeat 회 평가 — 판정+지문이 매회 동일한지(재현성) 측정. predicted=1회차(결정론이면 전 회차 동일).
export function scoreClaim(claim: BenchClaim, repeat: number): ClaimScore {
  const reps = Number.isFinite(repeat) && repeat >= 1 ? Math.floor(repeat) : 1;
  let firstV: Verdict | null = null;
  let firstFp = "";
  let firstGrade: Grade | null = null;
  let identical = true;
  const stmt = typeof claim.statement === "string" ? claim.statement : "";
  const url = typeof claim.sourceUrl === "string" ? claim.sourceUrl : null;
  for (let r = 0; r < reps; r++) {
    const ev = evaluateOfflineClaim(claim);
    const v = verdictOf(ev);
    const fp = claimFingerprintV1({
      statement: stmt,
      sourceUrl: url,
      checkKinds: Object.entries(ev.results).filter(([, s]) => s != null).map(([k]) => k),
    });
    if (firstV === null) {
      firstV = v;
      firstFp = fp;
      firstGrade = ev.assuranceGrade;
    } else if (v !== firstV || fp !== firstFp) {
      identical = false;
    }
  }
  const predicted: Verdict = firstV ?? "advisory";
  const expected = isVerdict(claim.expected) ? claim.expected : null;
  return {
    statement: stmt || "(statement 없음)",
    expected,
    predicted,
    runs: reps,
    identical,
    correct: expected === null ? null : predicted === expected,
    fingerprint: firstFp,
    assuranceGrade: firstGrade,
  };
}

// 혼동행렬(positive = failed = 나쁜 주장 포착) + 재현성 집계.
export interface BenchMetrics {
  total: number;
  labeled: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  byVerdict: { verified: number; failed: number; advisory: number }; // predicted 분포
  byGrade: { A: number; B: number; C: number; none: number }; // R2: assuranceGrade 분포
  reproducible: boolean; // 모든 주장이 runs 회 전부 동일
  identicalClaims: number;
  runsPerClaim: number;
  totalEvaluations: number;
}

export function computeMetrics(scores: ClaimScore[]): BenchMetrics {
  let tp = 0, fp = 0, fn = 0, tn = 0, labeled = 0, correct = 0, identicalClaims = 0, runsPerClaim = 0, totalEvaluations = 0;
  const byVerdict = { verified: 0, failed: 0, advisory: 0 };
  const byGrade = { A: 0, B: 0, C: 0, none: 0 };
  for (const s of scores) {
    byVerdict[s.predicted]++;
    if (s.assuranceGrade) byGrade[s.assuranceGrade]++;
    else byGrade.none++;
    if (s.identical) identicalClaims++;
    if (s.runs > runsPerClaim) runsPerClaim = s.runs;
    totalEvaluations += s.runs;
    if (s.expected !== null) {
      labeled++;
      const predPos = s.predicted === "failed";
      const expPos = s.expected === "failed";
      if (predPos && expPos) tp++;
      else if (predPos && !expPos) fp++;
      else if (!predPos && expPos) fn++;
      else tn++;
      if (s.correct) correct++;
    }
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  const accuracy = labeled > 0 ? correct / labeled : null;
  return {
    total: scores.length, labeled, tp, fp, fn, tn, precision, recall, f1, accuracy,
    byVerdict, byGrade, reproducible: identicalClaims === scores.length, identicalClaims, runsPerClaim, totalEvaluations,
  };
}

const line = "─".repeat(56);
const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);

/**
 * `agent-receipt bench --file <dataset.json|.md> [--repeat N] [--out <p>]`
 *  라벨된 주장셋에서 검사기의 정밀·재현율 + N회 재현성 측정.
 *  - 파일 없음/파싱 실패/주장 0건 → exit 2
 *  - 재현성 위반(같은 입력이 다른 판정) → exit 1  (불변식 회귀가드 — 정확도는 게이트 아님)
 *  - 측정 완료 → exit 0
 */
export function runBench(fileArg: string | undefined, opts: { repeat?: number; out?: string } = {}): never {
  if (!fileArg) {
    console.error("bench: --file <dataset.json|.md> 가 필요합니다 (각 주장에 expected=verified|failed|advisory gold 라벨).");
    process.exit(2);
  }
  const p = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    console.error(`bench: 파일을 못 읽음: ${fileArg}`);
    process.exit(2);
  }

  let query = "(query 없음)";
  let claims: BenchClaim[] = [];
  if (/\.(md|markdown)$/i.test(fileArg)) {
    const parsed = parseMarkdownReport(raw);
    query = parsed.query || query;
    claims = parsed.claims as BenchClaim[];
  } else {
    try {
      const j: unknown = JSON.parse(raw);
      if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("not an object");
      const rep = j as { query?: unknown; claims?: unknown };
      if (typeof rep.query === "string") query = rep.query;
      claims = Array.isArray(rep.claims) ? rep.claims.filter((c): c is BenchClaim => !!c && typeof c === "object" && !Array.isArray(c)) : [];
    } catch {
      console.error(`bench: JSON 파싱 실패: ${fileArg}`);
      process.exit(2);
    }
  }
  if (claims.length === 0) {
    console.error(`bench: 주장 0건: ${fileArg} — 라벨된 주장셋이 필요합니다.`);
    process.exit(2);
  }

  const repeat = Number.isFinite(opts.repeat) && (opts.repeat as number) >= 1 ? Math.floor(opts.repeat as number) : 5;
  const scores = claims.map((c) => scoreClaim(c, repeat));
  const m = computeMetrics(scores);

  console.log("");
  console.log(line);
  console.log(`bench: ${query}  (검사기 정밀·재현율 + ${repeat}회 재현성 · 결정론·비-LLM)`);
  console.log(line);
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i] as ClaimScore;
    const mark = s.expected === null ? "·" : s.correct ? "✓" : "✗";
    const lab = s.expected ? `gold ${s.expected}` : "unlabeled";
    const rep = s.identical ? `${s.runs}/${s.runs} 동일` : `⚠ 비결정(${s.runs}회 중 불일치)`;
    const gr = s.assuranceGrade ? ` [등급 ${s.assuranceGrade} · ${GRADE_LABELS[s.assuranceGrade]}]` : "";
    const st = s.statement.length > 46 ? s.statement.slice(0, 43) + "..." : s.statement;
    console.log(`[${i + 1}] ${mark} predicted ${s.predicted}${gr} · ${lab} · ${rep}  ${st}`);
  }
  console.log(line);
  console.log(`재현성: ${m.identicalClaims}/${m.total} 주장이 ${repeat}회 전부 동일 (${m.totalEvaluations} 평가) → ${m.reproducible ? "✅ 완전 재현" : "❌ 비결정 발견"}`);
  console.log(`predicted 분포: verified ${m.byVerdict.verified} · failed ${m.byVerdict.failed} · abstain(보류) ${m.byVerdict.advisory}`);
  console.log(`보증 등급(R2·assurance): A(재계산) ${m.byGrade.A} · B(대조) ${m.byGrade.B} · C(형식) ${m.byGrade.C} · 없음 ${m.byGrade.none}`);
  if (m.labeled > 0) {
    console.log(`혼동행렬(positive=failed·나쁜 주장 포착): TP ${m.tp} · FP ${m.fp} · FN ${m.fn} · TN ${m.tn}  (라벨 ${m.labeled}건)`);
    console.log(`정밀 ${pct(m.precision)} · 재현율 ${pct(m.recall)} · F1 ${pct(m.f1)} · 정확도 ${pct(m.accuracy)}`);
  } else {
    console.log("gold 라벨(expected) 없음 → 재현성만 측정(정밀/재현율 생략).");
  }
  console.log("  ⚠ 정직: 라벨=객관 gold(커밋 존재·부분문자열 일치). 이 시드셋 지표는 표본내·표본력 없음 — 세계 정확도 아님. 외부 공개셋은 같은 문법으로 후속. LLM-judge 대비는 재현성만 주장.");
  if (opts.out) {
    const outP = isAbsolute(opts.out) ? opts.out : join(process.cwd(), opts.out);
    const { receiptId, contentHash } = writeVerificationReceipt(outP, {
      surface: "bench",
      inputFile: fileArg,
      inputRaw: raw,
      subject: query,
      provenance: tierProvenance(undefined),
      results: scores.map((s) => ({ statement: s.statement, expected: s.expected, predicted: s.predicted, assuranceGrade: s.assuranceGrade, correct: s.correct, identical: s.identical, runs: s.runs, fingerprint: s.fingerprint })),
      summary: { total: m.total, labeled: m.labeled, tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn, identicalClaims: m.identicalClaims, reproducible: m.reproducible ? 1 : 0 },
      verdict: m.reproducible ? "pass" : "fail",
      verifiedAt: new Date().toISOString(),
    });
    console.log(`  📄 Verification Receipt: ${opts.out} (receiptId ${receiptId.slice(0, 12)}…·contentHash ${contentHash.slice(0, 12)}…)`);
  }
  console.log(line);
  console.log("");
  process.exit(m.reproducible ? 0 : 1);
}
