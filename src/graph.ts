import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claimFingerprintV1, CHECK_KINDS } from "./evidencekernel.js";
import { replayVerificationReceipt } from "./vreceipt.js";

const line = "─".repeat(56);

// ── Evidence Graph — 조회/색인 + 관계(edge) 레이어 (L6 v2) ──
// 쌓인 Verification Receipt 를 commit/input/model/receiptId 로 질의(읽기전용·중립)하고,
// 기록된 사실만으로 노드/엣지를 재표현한다(buildGraph — 창작 0·결정론):
//   Receipt→Claim→Check(asserts/checked_by) + receipt 간 same_input(verified)·same_commit(reported)·reverifies(시간순).
// v2 에서 edge 가 실재하므로 "Evidence Graph" 이름이 성립한다(전엔 조회/색인이라 명시적으로 graph 아님이라 했음).
// 집계는 pass/fail 카운트(중립·점수/판단 아님·insights 범주).

export interface VRRow {
  receiptId: string;
  subject: string;
  verdict: string;
  surface: string;
  model: string | null;
  commit: string | null;
  inputSha: string | null;
  verifiedAt: string | null;
  file: string;
}

// 디렉터리의 verification-receipt JSON 만 로드(다른 파일·손상 파일 skip).
export function loadReceipts(dir: string): VRRow[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: VRRow[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (!r || r.kind !== "verification-receipt") continue;
      const prov = ((r.provenance as { reported?: Record<string, unknown> } | undefined)?.reported) ?? {};
      const input = r.input as { sha256?: unknown } | undefined;
      out.push({
        receiptId: typeof r.receiptId === "string" ? r.receiptId : "",
        subject: typeof r.subject === "string" ? r.subject : "",
        verdict: typeof r.verdict === "string" ? r.verdict : "",
        surface: typeof r.surface === "string" ? r.surface : "",
        model: typeof prov.model === "string" ? prov.model : null,
        commit: typeof prov.commit === "string" ? prov.commit : null,
        inputSha: typeof input?.sha256 === "string" ? input.sha256 : null,
        verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : null,
        file: f,
      });
    } catch {
      /* 손상 파일 skip */
    }
  }
  return out;
}

export interface GraphFilters {
  commit?: string;
  input?: string;
  model?: string;
  receiptId?: string;
}

export function queryReceipts(rows: VRRow[], f: GraphFilters): VRRow[] {
  return rows.filter(
    (r) =>
      (!f.commit || r.commit === f.commit) &&
      (!f.input || r.inputSha === f.input) &&
      (!f.model || r.model === f.model) &&
      (!f.receiptId || r.receiptId === f.receiptId),
  );
}

function resolveDir(dirArg: string | undefined): string {
  return dirArg ? (isAbsolute(dirArg) ? dirArg : join(process.cwd(), dirArg)) : join(process.cwd(), ".agent-guard", "vreceipts");
}

function aggregate(rows: FoldedVRRow[]): { pass: number; fail: number; byModel: Record<string, { pass: number; fail: number }> } {
  const pass = rows.filter((r) => r.verdict === "pass").length;
  const byModel: Record<string, { pass: number; fail: number }> = {};
  for (const r of rows) {
    const m = r.model ?? "(unknown)";
    (byModel[m] ??= { pass: 0, fail: 0 });
    if (r.verdict === "pass") byModel[m].pass++;
    else byModel[m].fail++;
  }
  return { pass, fail: rows.length - pass, byModel };
}

/**
 * `agent-receipt graph query --dir <d> [--commit <h>] [--input <sha>] [--model <m>] [--receipt-id <id>] [--format json]`
 *  쌓인 Verification Receipt 를 질의(접힘 후=고유 결과). 읽기전용·중립 카운트. --format json = UI/기계용. exit 0.
 */
export function runGraphQuery(dirArg: string | undefined, f: GraphFilters, format?: string): never {
  const dir = resolveDir(dirArg);
  const allRaw = loadReceipts(dir);
  const rows = foldVRRows(queryReceipts(allRaw, f)); // 접힘: 같은 receiptId 반복(예: dogfood 재검증)은 한 행
  const agg = aggregate(rows);

  if (format === "json") {
    console.log(JSON.stringify({ dir, fileCount: allRaw.length, total: rows.length, matched: rows.length, rows, aggregate: agg }, null, 2));
    process.exit(0);
  }

  console.log("");
  console.log(line);
  console.log(`Evidence Graph 조회: ${dir}  (파일 ${allRaw.length}개 중 고유 ${rows.length}건 일치)`);
  console.log(line);
  for (const r of rows) {
    console.log(`  ${r.verdict === "pass" ? "✓" : "✗"} ${r.receiptId.slice(0, 12)}… [${r.surface}] ${r.subject.slice(0, 40)}${r.occurrences > 1 ? ` ×${r.occurrences}` : ""}`);
    console.log(`      model=${r.model ?? "-"} · commit=${r.commit ? r.commit.slice(0, 8) : "-"} · input=${r.inputSha ? r.inputSha.slice(0, 8) : "-"}`);
  }
  if (!rows.length) console.log("  (일치 영수증 없음)");
  console.log(line);
  console.log(`집계: pass ${agg.pass} · fail ${agg.fail}  (중립 카운트 · 점수/판단 아님)`);
  for (const [m, c] of Object.entries(agg.byModel)) console.log(`  model ${m}: pass ${c.pass} · fail ${c.fail}`);
  console.log(line);
  console.log("");
  process.exit(0);
}

// ── 정적 HTML 뷰어 (share-proof 패턴·서버 0) ──
// 각 receipt 를 replay 로 무결성 계산해 임베드 → 브라우저에서 필터·drill-down("왜 통과/실패").

// Reason 객체 = 실패 check 를 3단계로: check → reason(무엇이 틀렸나) → hint(기계적 조치).
// reason/hint 모두 *고정 매핑*(린터식·LLM 추천 아님·표시만·자동수정 0).
const REASON_MAP: Record<string, string> = {
  citation: "인용문이 출처 텍스트에 없음",
  number: "수치가 출처/재계산 값과 다름",
  date: "날짜가 출처에 없음",
  hash: "content 해시가 statedHash 와 다름",
  signature: "서명이 검증되지 않음",
  link: "URL 형식이 잘못됨",
};
const HINT_MAP: Record<string, string> = {
  citation: "인용문을 출처의 정확한 문장으로 맞추거나 출처를 확인",
  number: "수치를 출처/재계산과 맞추거나 피연산자를 확인",
  date: "날짜를 출처와 맞추거나 표기를 확인",
  hash: "content 를 다시 해시하거나 statedHash 를 갱신",
  signature: "서명을 재생성하거나 공개키를 확인",
  link: "URL 형식을 확인",
};
const FAILED = new Set(["not-found", "mismatch", "invalid"]);

export interface FailureReason {
  check: string;
  status: string;
  reason: string; // 설명(무엇이 틀렸나)
  evidence: { expected: string; actual: string } | null; // 증명(expected↔actual·커널 생산)
  hint: string; // 기계적 조치(고정 매핑)
}
interface EnrichedClaim {
  statement: string;
  verdict: string;
  fingerprint: string; // cfp1: 시간축 동일성 키 — 영수증 임베드 우선·없으면 같은 커널 함수로 재계산(신구 일관)
  checks: Record<string, string | null>;
  failures: FailureReason[]; // Reason 객체(check→reason→evidence→hint)
}
function enrichClaims(results: unknown): EnrichedClaim[] {
  if (!Array.isArray(results)) return [];
  return results.map((c) => {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const checks = (o.checks && typeof o.checks === "object" ? o.checks : {}) as Record<string, string | null>;
    const evMap = (o.evidence && typeof o.evidence === "object" ? o.evidence : {}) as Record<string, { expected?: unknown; actual?: unknown }>;
    const statement = typeof o.statement === "string" ? o.statement : "";
    const fingerprint = typeof o.fingerprint === "string" && o.fingerprint.startsWith("cfp")
      ? o.fingerprint // 영수증이 임베드한 값(같은 커널 함수 산출)
      : claimFingerprintV1({
          statement,
          sourceUrl: typeof o.sourceUrl === "string" ? o.sourceUrl : null,
          checkKinds: Object.entries(checks).filter(([, v]) => v != null).map(([k]) => k),
        });
    const failures: FailureReason[] = [];
    for (const [kind, st] of Object.entries(checks)) {
      if (typeof st === "string" && FAILED.has(st)) {
        const e = evMap[kind];
        failures.push({
          check: kind,
          status: st,
          reason: REASON_MAP[kind] ?? "검증 실패",
          evidence: e && typeof e === "object" ? { expected: String(e.expected ?? ""), actual: String(e.actual ?? "") } : null,
          hint: HINT_MAP[kind] ?? "확인 필요",
        });
      }
    }
    return {
      statement,
      verdict: typeof o.verdict === "string" ? o.verdict : "",
      fingerprint,
      checks,
      failures,
    };
  });
}

interface ViewRow {
  receiptId: string; subject: string; verdict: string; surface: string;
  model: string | null; commit: string | null; inputSha: string | null;
  verifiedAt: string | null;
  file: string; // 디렉터리 내 파일명 — receiptId 결측/중복 시 안정 식별자
  integrity: { contentHashOk: boolean; receiptIdOk: boolean; inputMatch: boolean | null; commitRecheck: boolean | null };
  claims: EnrichedClaim[];
  unreachable: number; // --fetch 시 출처 도달 실패 수(영수증 summary 자가기록·없으면 0) — 예외 집계용
}

// ── 예외(exception) 목록 — 동결 enum · 검증트랙에서 이미 기록되는 사실의 분류일 뿐(발명 0·상태/워크플로 없음) ──
// gate_bypassed(작업영수증 트랙)는 graph 가 verification-receipt 만 로드하므로 구조적으로 여기 없음(스펙 명시).
export const EXCEPTION_KINDS = ["seal_failed", "ungrounded_decision", "source_unreachable"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

// Dashboard 요약(생성시점 집계·중립 카운트). total=고유 결과 수(receiptId 접힘 후) · fileCount=파일 수(접기 전) —
//   같은 fixture 를 반복 재검증(dogfood 등)하면 total<fileCount 로 벌어짐. 정직: 둘 다 노출(하나 숨기지 않음).
export interface GraphSummary {
  total: number; fileCount: number; pass: number; fail: number;
  byModel: Record<string, { pass: number; fail: number }>;
  checkFailures: Record<string, number>;
  mostFailedCheck: string | null;
  driftCount: number; // inputMatch===false 또는 commitRecheck===false
  tamperedCount: number; // contentHashOk/receiptIdOk 불일치
  exceptions: Record<ExceptionKind, number>; // 동결 3종 분류 카운트(접힘 후·상태/워크플로 없음)
}
export function buildSummary(rows: ViewRow[]): GraphSummary {
  const folded = foldReceipts(rows);
  let pass = 0, fail = 0, driftCount = 0, tamperedCount = 0;
  const byModel: Record<string, { pass: number; fail: number }> = {};
  const checkFailures: Record<string, number> = {};
  for (const r of folded) {
    if (r.verdict === "pass") pass++;
    else if (r.verdict === "fail") fail++;
    const m = r.model ?? "(unknown)";
    (byModel[m] ??= { pass: 0, fail: 0 });
    if (r.verdict === "pass") byModel[m].pass++;
    else byModel[m].fail++;
    if (r.integrity.inputMatch === false || r.integrity.commitRecheck === false) driftCount++;
    if (!r.integrity.contentHashOk || !r.integrity.receiptIdOk) tamperedCount++;
    for (const c of r.claims) for (const f of c.failures) checkFailures[f.check] = (checkFailures[f.check] ?? 0) + 1;
  }
  const entries = Object.entries(checkFailures).sort((a, b) => b[1] - a[1]);
  // 예외 분류(동결 3종·접힘 후 — 반복 재검증이 예외 수를 부풀리지 않게): 전부 이미 기록된 사실의 재분류.
  const exceptions: Record<ExceptionKind, number> = { seal_failed: 0, ungrounded_decision: 0, source_unreachable: 0 };
  for (const r of folded) {
    if (!r.integrity.contentHashOk || !r.integrity.receiptIdOk) exceptions.seal_failed++;
    if (r.surface === "council" && r.verdict === "fail") exceptions.ungrounded_decision++;
    exceptions.source_unreachable += r.unreachable ?? 0;
  }
  return { total: folded.length, fileCount: rows.length, pass, fail, byModel, checkFailures, mostFailedCheck: entries[0]?.[0] ?? null, driftCount, tamperedCount, exceptions };
}

// Failure-first: 실패 receipt 별 reason + 영향받은 claim. rows 는 접힘(fold) 후 — 같은 결과 반복은 occurrences 로.
export interface FailureEntry { receiptId: string; subject: string; reasons: string[]; affectedClaims: number[]; occurrences: number }
export function buildFailures(rows: ViewRow[]): FailureEntry[] {
  return foldReceipts(rows)
    .filter((r) => r.verdict === "fail")
    .map((r) => {
      const reasons = new Set<string>();
      const affectedClaims: number[] = [];
      r.claims.forEach((c, i) => {
        if (c.failures.length) {
          affectedClaims.push(i + 1);
          c.failures.forEach((f) => reasons.add(`${f.check}: ${f.reason}`));
        }
      });
      return { receiptId: r.receiptId, subject: r.subject, reasons: [...reasons], affectedClaims, occurrences: r.occurrences };
    });
}

// FailureEvent = 실패 1건(claim×실패check)을 flat 정규화 — indexes 의 source. rows 는 접힘 후(같은 결과 반복=occurrences).
export interface FailureEvent {
  receiptId: string;
  file: string; // 접힘 후 대표(최신) 파일명 — allFiles 에 전체
  allFiles: string[]; // 접힌 파일명 전부(occurrences 와 길이 일치)
  occurrences: number; // 이 논리적 결과가 몇 개 파일로 반복됐나(같은 fixture 재검증 등)
  subject: string;
  model: string | null;
  commit: string | null; // 자가보고(provenance.reported)
  inputSha: string | null;
  verifiedAt: string | null; // 자가보고 타임스탬프(접힘 후=최신)
  tampered: boolean; // 영수증 봉인 재검증 실패(contentHash/receiptId)
  claimIndex: number;
  statement: string;
  fingerprint: string; // cfp1: — triage→history 를 잇는 키
  check: string;
  status: string;
  isNew?: boolean; // graph view --base-dir 제공 시에만 존재 — base 대비 신규 실패(미제공=필드 자체 없음·구 출력 불변)
  reason: string;
}
export function buildFailureEvents(rows: ViewRow[]): FailureEvent[] {
  const out: FailureEvent[] = [];
  for (const r of foldReceipts(rows)) {
    const tampered = !r.integrity.contentHashOk || !r.integrity.receiptIdOk;
    r.claims.forEach((c, i) => {
      c.failures.forEach((f) => {
        out.push({
          receiptId: r.receiptId, file: r.file, allFiles: r.allFiles, occurrences: r.occurrences,
          subject: r.subject, model: r.model, commit: r.commit,
          inputSha: r.inputSha, verifiedAt: r.verifiedAt, tampered,
          claimIndex: i + 1, statement: c.statement, fingerprint: c.fingerprint, check: f.check, status: f.status, reason: f.reason,
        });
      });
    });
  }
  return out;
}

// Failure Index: 실패를 5차원으로 pivot(소비자가 receipt 순회 없이 lookup 한 번에).
export interface GraphIndexes {
  byCheck: Record<string, FailureEvent[]>;
  byModel: Record<string, FailureEvent[]>;
  bySubject: Record<string, FailureEvent[]>;
  byCommit: Record<string, FailureEvent[]>;
  byReason: Record<string, FailureEvent[]>;
}
export function buildIndexes(rows: ViewRow[]): GraphIndexes {
  const events = buildFailureEvents(rows);
  const by = (keyFn: (e: FailureEvent) => string | null): Record<string, FailureEvent[]> => {
    const m: Record<string, FailureEvent[]> = {};
    for (const e of events) {
      const k = keyFn(e) ?? "(none)";
      (m[k] ??= []).push(e);
    }
    return m;
  };
  return { byCheck: by((e) => e.check), byModel: by((e) => e.model), bySubject: by((e) => e.subject), byCommit: by((e) => e.commit), byReason: by((e) => e.reason) };
}

// ── Subject 상태판(L6) — subject 별 순수 롤업(카운트만·추세/점수 판정 0) ──
// "이 프로젝트가 늘었나/줄었나"는 여기가 아니라 graph diff(두 집합 비교 사실)의 bySubject 가 답한다.
// 시각(first/last)은 verifiedAt=자가보고 — 표시 시 라벨. receipts=고유 결과 수(접힘 후·파일수 아님).
export interface SubjectRollup {
  subject: string;
  receipts: number;
  pass: number;
  fail: number;
  failureEvents: number;
  tamperedReceipts: number;
  byCheck: Record<string, number>;
  firstVerifiedAt: string | null;
  lastVerifiedAt: string | null;
}
export function buildSubjects(rows: ViewRow[]): SubjectRollup[] {
  const m = new Map<string, SubjectRollup>();
  for (const r of foldReceipts(rows)) {
    const k = r.subject || "(subject 없음)";
    const s = m.get(k) ?? { subject: k, receipts: 0, pass: 0, fail: 0, failureEvents: 0, tamperedReceipts: 0, byCheck: {}, firstVerifiedAt: null, lastVerifiedAt: null };
    s.receipts++;
    if (r.verdict === "pass") s.pass++;
    else if (r.verdict === "fail") s.fail++;
    if (!r.integrity.contentHashOk || !r.integrity.receiptIdOk) s.tamperedReceipts++;
    const ct = canonTime(r.verifiedAt);
    if (ct) {
      if (!s.firstVerifiedAt || ct < (canonTime(s.firstVerifiedAt) ?? "")) s.firstVerifiedAt = r.verifiedAt;
      if (!s.lastVerifiedAt || ct > (canonTime(s.lastVerifiedAt) ?? "")) s.lastVerifiedAt = r.verifiedAt;
    }
    for (const c of r.claims)
      for (const f of c.failures) {
        s.failureEvents++;
        s.byCheck[f.check] = (s.byCheck[f.check] ?? 0) + 1;
      }
    m.set(k, s);
  }
  return [...m.values()].sort((a, b) => b.failureEvents - a.failureEvents || cmpStr(a.subject, b.subject));
}
/**
 * `agent-receipt graph subjects --dir <d> [--format json]`
 *  subject(프로젝트/질문) 단위 상태판 — 순수 카운트 롤업(추세/점수 판정 없음·읽기전용·exit 0).
 */
export function runGraphSubjects(dirArg: string | undefined, format?: string): never {
  const dir = resolveDir(dirArg);
  const rows = buildViewData(dir);
  const subs = buildSubjects(rows);
  if (format === "json") {
    console.log(JSON.stringify({ dir, fileCount: rows.length, total: foldReceipts(rows).length, subjects: subs, note: "receipts=고유 결과(접힘 후)·판단 아님·증감은 graph diff 의 bySubject·시각=verifiedAt(자가보고)" }, null, 2));
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log(`Subject 상태판: ${dir}  (파일 ${rows.length}개 중 고유 ${foldReceipts(rows).length}건 · subject ${subs.length}개 · 실패 많은 순)`);
  console.log(line);
  if (!subs.length) console.log("  (영수증 없음)");
  for (const s of subs) {
    console.log(`  ■ ${s.subject.slice(0, 44)}`);
    console.log(`      영수증 ${s.receipts} · pass ${s.pass} · fail ${s.fail} · 실패 이벤트 ${s.failureEvents}${s.tamperedReceipts ? ` · ⚠ 봉인확인실패 ${s.tamperedReceipts}` : ""}`);
    const checks = Object.entries(s.byCheck).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
    if (checks) console.log(`      실패 check: ${checks}`);
    console.log(`      기간: ${s.firstVerifiedAt ?? "-"} ~ ${s.lastVerifiedAt ?? "-"} (자가보고)`);
  }
  console.log(line);
  console.log("  참고: 카운트 롤업(판단 아님) · 증감은 graph diff 의 bySubject · subject 이력은 graph history --subject.");
  console.log(line);
  console.log("");
  process.exit(0);
}

// ── 진짜 edge layer (L6 v2) — Receipt→Claim→Check 노드/엣지 + receipt 간 관계 ──
// 전부 기록된 사실의 결정론 재표현(창작 0). 엣지마다 basis(무슨 기록으로 만들었나)+tier.
//
// tier 규율(자가보고를 verified 로 세탁 금지 — provenance 계층화·A>B>C 와 같은 규율):
//   verified = 이 도구가 직접 읽음/재계산으로 확인한 사실만.
//     asserts/checked_by : 영수증 파일의 구조를 직접 읽음(포함관계 사실 — 내용의 진위 아님).
//     same_input         : 양쪽 모두 입력 파일을 재해시해 기재 sha256 과 일치(inputMatch===true)했을 때만.
//   reported = 영수증 기재값에 기댄 관계(재계산 경로 없음/불가).
//     same_input(재해시 불가·불일치 포함) · same_commit(자가보고 commit) ·
//     reverifies(방향 근거인 verifiedAt 이 호출부 주입 자가보고 타임스탬프 — 재계산 경로 없음).
//
// 접힘: 같은 receiptId(=같은 입력·검증기버전·verdict)는 한 노드로 —
//   최신 verifiedAt 행의 속성 유지 + occurrences/verifiedAtAll 로 접힌 기록 전부 보존(나중 재검증 사실을 버리지 않음).
//   동률 tie-break=file(파일시스템 열거 순서 비의존). receiptId 결측은 접지 않고 receipt:file:<파일명> 으로 구분.
// reverifies 는 verdict/검증기버전이 달라진 재검증에서만 생긴다(같으면 같은 id 로 접히므로).
// 봉인 확인 실패(contentHash/receiptId 재계산 불일치·부재)는 노드에 tampered 표시(생략이 아니라 노출).
// 시간은 Date.parse 정규화(오프셋 ISO-8601 안전)·비교는 코드포인트(로케일/ICU 비의존).
// verifiedAt 동률/파싱불가면 reverifies 방향 단정 불가 → 엣지 생략(정직).
// 정직: "derived_from" 이라 부르지 않는다 — 재검증은 파생(계보)의 증명이 아니다.
//   진짜 파생 엣지는 영수증이 명시 선언 필드를 갖게 될 때만(future).
// pair 엣지는 그룹 내 O(n²) — 침묵 캡 없이 전부 방출(전형 볼륨 소규모).
// ── Edge 계약(기계 판독·versioned) — 외부 소비자가 graph view --format json 만 보고 관계 복원 가능해야 함 ──
// enum 은 동결 테스트로 고정(값 *추가*는 additive·기존 값 의미 변경은 불가).
export type GraphEdgeType = "asserts" | "checked_by" | "same_input" | "same_commit" | "reverifies";
export type EdgeBasis =
  | "receipt-structure"      // 영수증 파일에서 직접 읽은 포함관계/checks 기록(구조 사실)
  | "input.sha256-rehashed"  // 양쪽 입력 파일을 이 도구가 재해시해 기재값과 일치 확인
  | "input.sha256-stated"    // 영수증 기재 sha256 동일(재해시 불가/미일치 — 기재값 신뢰)
  | "reported.commit"        // provenance.reported.commit 동일(자가보고)
  | "verifiedAt-order";      // verifiedAt(자가보고 타임스탬프) 시간순
export interface GraphNode {
  id: string;
  type: "receipt" | "claim" | "check";
  [k: string]: unknown;
}
export interface GraphEdge {
  id: string; // 결정론: `${type}:${from}=>${to}`
  from: string;
  to: string;
  type: GraphEdgeType;
  basis: EdgeBasis; // 기계 판독 — 무슨 기록으로 이 엣지를 만들었나
  note: string; // 사람 설명(표시용·계약 아님)
  tier: "verified" | "reported"; // 근거의 신뢰 계층(provenance 계층화와 같은 규율)
}
const edge = (type: GraphEdgeType, from: string, to: string, basis: EdgeBasis, note: string, tier: "verified" | "reported"): GraphEdge =>
  ({ id: `${type}:${from}=>${to}`, from, to, type, basis, note, tier });
const canonTime = (v: string | null): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0); // 코드포인트·로케일 비의존

// ── 접힘(fold) SSOT — 같은 receiptId(=같은 입력·검증기버전·verdict)를 한 논리적 결과로 묶는다 ──
// 감사 발견(2026-07-02): buildGraph 는 이 접힘을 하는데 buildSummary/buildFailures/buildIndexes/
//   HTML 목록은 파일 단위로 순회해 안 접었다 — 같은 dogfood 픽스처를 npm test 로 반복 돌리면
//   "파일 22개·고유결과 9개"인데 화면엔 22개가 다 다른 것처럼 나열되는 결함으로 드러남.
//   이제 이 함수가 유일한 접힘 로직(SSOT) — buildGraph 와 아래 buildSummary/buildFailures/
//   buildFailureEvents/buildSubjects 전부 이걸 공유해 항상 같은 방식으로 접는다.
// receiptId 결측은 접지 않음(file 이 사실상 유일 키). 최신 verifiedAt 행의 필드 유지 +
//   occurrences/verifiedAtAll/allFiles 로 접힌 기록 전부 보존(나중 재검증 사실을 버리지 않음).
interface FoldExtra { foldKey: string; occurrences: number; verifiedAtAll: string[]; allFiles: string[] }
export type FoldedRow = ViewRow & FoldExtra;
export type FoldedVRRow = VRRow & FoldExtra;
// 제네릭 구현 — ViewRow(graph view 계열)·VRRow(graph query 계열) 둘 다 이 하나로 접는다(SSOT 실제 공유).
// foldKey: receiptId 또는 `file:<파일명>`(결측 시). 최신 verifiedAt 행의 필드 유지 +
//   occurrences/verifiedAtAll/allFiles 로 접힌 기록 전부 보존(나중 재검증 사실을 버리지 않음).
function foldByReceipt<T extends { receiptId: string; file: string; verifiedAt: string | null }>(rows: T[]): (T & FoldExtra)[] {
  interface Ent { row: T; foldKey: string; ct: string | null; times: string[]; files: string[] }
  const byKey = new Map<string, Ent>();
  for (const row of rows) {
    const foldKey = row.receiptId || `file:${row.file}`;
    const ct = canonTime(row.verifiedAt);
    const prev = byKey.get(foldKey);
    if (!prev) {
      byKey.set(foldKey, { row, foldKey, ct, times: row.verifiedAt ? [row.verifiedAt] : [], files: [row.file] });
      continue;
    }
    if (row.verifiedAt) prev.times.push(row.verifiedAt);
    prev.files.push(row.file);
    // 최신 verifiedAt 행 유지(동률이면 file 코드포인트 큰 쪽 — readdir 순서 비의존 tie-break)
    if ((cmpStr(ct ?? "", prev.ct ?? "") || cmpStr(row.file, prev.row.file)) > 0) {
      prev.row = row;
      prev.ct = ct;
    }
  }
  return [...byKey.values()]
    .sort((a, b) => cmpStr(a.ct ?? "", b.ct ?? "") || cmpStr(a.foldKey, b.foldKey) || cmpStr(a.row.file, b.row.file))
    .map((e) => ({
      ...e.row,
      foldKey: e.foldKey,
      occurrences: e.files.length,
      verifiedAtAll: e.times.slice().sort((x, y) => cmpStr(canonTime(x) ?? x, canonTime(y) ?? y)),
      allFiles: e.files.slice().sort(cmpStr),
    }));
}
export const foldReceipts = (rows: ViewRow[]): FoldedRow[] => foldByReceipt(rows);
export const foldVRRows = (rows: VRRow[]): FoldedVRRow[] => foldByReceipt(rows);

export function buildGraph(rows: ViewRow[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const uniq = foldReceipts(rows);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const isTampered = (e: FoldedRow): boolean => !e.integrity.contentHashOk || !e.integrity.receiptIdOk;
  const inputRehashed = (e: FoldedRow): boolean => e.integrity.inputMatch === true;
  for (const r of uniq) {
    const rid = `receipt:${r.foldKey}`;
    const node: GraphNode = {
      id: rid, type: "receipt", subject: r.subject, verdict: r.verdict, surface: r.surface,
      model: r.model, commit: r.commit, inputSha: r.inputSha, verifiedAt: r.verifiedAt, file: r.file,
    };
    if (isTampered(r)) node.tampered = true; // 봉인 확인 실패 — 숨기지 않고 표시
    if (r.occurrences > 1) {
      node.occurrences = r.occurrences; // 접힌 파일 수(기록 보존)
      node.verifiedAtAll = r.verifiedAtAll;
    }
    nodes.push(node);
    r.claims.forEach((c, i) => {
      const cid = `${rid}/claim/${i + 1}`;
      nodes.push({ id: cid, type: "claim", statement: c.statement, verdict: c.verdict, fingerprint: c.fingerprint });
      edges.push(edge("asserts", rid, cid, "receipt-structure", "영수증 파일에서 직접 읽은 포함관계(구조 사실)", "verified"));
      for (const [kind, stt] of Object.entries(c.checks)) {
        if (stt == null) continue;
        const kid = `${cid}/check/${kind}`;
        nodes.push({ id: kid, type: "check", check: kind, status: stt });
        edges.push(edge("checked_by", cid, kid, "receipt-structure", "영수증 파일에서 직접 읽은 checks 기록(구조 사실)", "verified"));
      }
    });
  }
  const ridOf = (e: FoldedRow): string => `receipt:${e.foldKey}`;
  const groupBy = (key: (r: FoldedRow) => string | null): Map<string, FoldedRow[]> => {
    const m = new Map<string, FoldedRow[]>();
    for (const e of uniq) {
      const k = key(e);
      if (!k) continue;
      const arr = m.get(k) ?? [];
      arr.push(e);
      m.set(k, arr);
    }
    return m;
  };
  for (const g of groupBy((r) => r.inputSha).values()) {
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++) {
        // verified 는 양쪽 입력을 우리가 실제 재해시해 기재값과 일치했을 때만(그 외=기재값 신뢰=reported).
        const rehashedBoth = inputRehashed(g[i]) && inputRehashed(g[j]);
        edges.push(
          rehashedBoth
            ? edge("same_input", ridOf(g[j]), ridOf(g[i]), "input.sha256-rehashed", "input.sha256 동일 — 양쪽 입력 파일 재해시로 확인(inputMatch)", "verified")
            : edge("same_input", ridOf(g[j]), ridOf(g[i]), "input.sha256-stated", "input.sha256 동일 — 영수증 기재값 기준(입력 재해시 불가/미일치 포함)", "reported"),
        );
      }
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i], b = g[i + 1];
      const at = canonTime(a.verifiedAt), bt = canonTime(b.verifiedAt);
      if (at && bt && bt > at)
        edges.push(edge("reverifies", ridOf(b), ridOf(a), "verifiedAt-order", "같은 input.sha256 + verifiedAt 시간순 — verifiedAt 은 자가보고 타임스탬프(파생의 증명 아님)", "reported"));
    }
  }
  for (const g of groupBy((r) => r.commit).values()) {
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++)
        edges.push(edge("same_commit", ridOf(g[j]), ridOf(g[i]), "reported.commit", "provenance.reported.commit 동일(자가보고)", "reported"));
  }
  return { nodes, edges };
}

export function buildViewData(dir: string): ViewRow[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ViewRow[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (!r || r.kind !== "verification-receipt") continue;
      // 입력 파일이 아직 있으면 재해시(드리프트)
      let inputContent: string | null = null;
      const inp = r.input as { file?: unknown; sha256?: unknown } | undefined;
      if (typeof inp?.file === "string") {
        const fp = isAbsolute(inp.file) ? inp.file : join(process.cwd(), inp.file);
        try {
          inputContent = readFileSync(fp, "utf8");
        } catch {
          inputContent = null;
        }
      }
      const integrity = replayVerificationReceipt(r, { inputContent });
      const prov = ((r.provenance as { reported?: Record<string, unknown> } | undefined)?.reported) ?? {};
      out.push({
        receiptId: typeof r.receiptId === "string" ? r.receiptId : "",
        subject: typeof r.subject === "string" ? r.subject : "",
        verdict: typeof r.verdict === "string" ? r.verdict : "",
        surface: typeof r.surface === "string" ? r.surface : "",
        model: typeof prov.model === "string" ? prov.model : null,
        commit: typeof prov.commit === "string" ? prov.commit : null,
        inputSha: typeof inp?.sha256 === "string" ? inp.sha256 : null,
        verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : null,
        file: f,
        integrity,
        claims: enrichClaims(r.results),
        unreachable: typeof (r.summary as { unreachable?: unknown } | undefined)?.unreachable === "number" ? ((r.summary as { unreachable: number }).unreachable) : 0,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

// histories 사전계산 상한 — 지문 수가 이걸 넘으면 정렬순 앞쪽만 계산하고 *명시적으로* 잘림을 표기(silent cap 금지).
const HISTORY_PRECOMPUTE_LIMIT = 500;

export interface GraphHtmlOpts {
  baseData?: ViewRow[]; // --base-dir 스냅샷 — 주면 신규 실패에 isNew 마킹(안 주면 출력 불변)
  match?: DiffMatchMode; // 신규 판정 매칭(--match 승계·기본 statement)
}
export function buildGraphHtml(data: ViewRow[], opts: GraphHtmlOpts = {}): string {
  // 체크종류 목록 SSOT — 커널 CHECK_KINDS 를 그대로 임베드(하드코딩 중복 금지·새 체크 추가 시 여기 안 고쳐도 됨).
  const checkKindsJs = JSON.stringify(CHECK_KINDS);
  // base 대비 신규 실패 키 집합(제공 시에만) — 기존 buildGraphDiff 재사용(새 비교 로직 0).
  const match: DiffMatchMode = opts.match ?? "statement";
  const newKeys: Set<string> | null = opts.baseData
    ? new Set(buildGraphDiff(opts.baseData, data, { match }).newFailures.map((e) => failureKey(e, match)))
    : null;
  const markNew = <T extends FailureEvent>(events: T[]): T[] =>
    newKeys ? events.map((e) => (newKeys.has(failureKey(e, match)) ? { ...e, isNew: true } : e)) : events;
  // Evidence Browser: Failure-first 순서 — Dashboard → Failures(indexes 탭: Check별/Model별/…) →
  //   Reason(→Evidence) → Affected Claim → 주장 이력(1클릭) → Receipt 상세(맨 마지막 drill-down).
  // 임베드 JSON + vanilla JS. 외부 리소스 0·서버 0(share-proof 패턴·이식 리포트).
  // histories = 지문별 이력 *사전계산*(생성 시점·TS buildHistory 단일 함수=SSOT) —
  //   브라우저 JS 로 이력 로직을 재구현하지 않는다(두 진실원 금지). 대형 볼륨 처리=L8 하드닝.
  const fps = new Set<string>();
  for (const r of data) for (const c of r.claims) fps.add(c.fingerprint);
  const fpSorted = [...fps].sort(cmpStr);
  const fpShown = fpSorted.slice(0, HISTORY_PRECOMPUTE_LIMIT);
  const historiesTruncated = fpSorted.length > fpShown.length ? { shown: fpShown.length, total: fpSorted.length } : null;
  const histories: Record<string, HistoryItem[]> = {};
  for (const fp of fpShown) histories[fp] = buildHistory(data, { claim: fp }).timeline;
  const rawIndexes = buildIndexes(data);
  const indexes = newKeys
    ? (Object.fromEntries(Object.entries(rawIndexes).map(([grp, m]) => [grp, Object.fromEntries(Object.entries(m as Record<string, FailureEvent[]>).map(([k, evs]) => [k, markNew(evs)]))])) as unknown as GraphIndexes)
    : rawIndexes;
  const newFailureCount = newKeys ? newKeys.size : null;
  const embedded = JSON.stringify({
    receipts: data, folded: foldReceipts(data), summary: buildSummary(data), indexes, failures: buildFailures(data), histories,
    ...(historiesTruncated ? { historiesTruncated } : {}),
    ...(newFailureCount !== null ? { newFailureCount } : {}),
    subjects: buildSubjects(data),
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evidence Browser — Verification Receipts</title><style>
:root{
  --bg:#f1f2f4;--bg-raised:#f8f9fa;--bg-hover:#e9ebee;--border:#dadde2;--border-soft:#e6e8eb;
  --text:#24292f;--mut:#57606a;--pass:#1a7f37;--fail:#d03b3b;--warn:#9a6700;--accent:#0969da;
  --pass-bg:#1a7f3717;--fail-bg:#d03b3b14;--warn-bg:#9a670014;--accent-bg:#0969da14;
  --font-ui:-apple-system,BlinkMacSystemFont,"Segoe UI",Pretendard,Roboto,"Helvetica Neue",Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-ui);font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
header{padding:18px 24px;border-bottom:1px solid var(--border)}h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.015em;font-family:var(--font-mono)}.sub{color:var(--mut);font-size:13px;margin-top:5px}
.dash{display:flex;gap:10px;flex-wrap:wrap;padding:16px 24px;border-bottom:1px solid var(--border)}
.cd{border:1px solid var(--border);border-top:3px solid var(--border);border-radius:10px;padding:11px 18px;min-width:96px;background:var(--bg-raised)}
.cd.pass{border-top-color:var(--pass)}.cd.fail{border-top-color:var(--fail)}.cd.warn{border-top-color:var(--warn)}
.cd .n{font-size:25px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text);font-family:var(--font-mono)}
.cd .l{font-size:11.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-top:4px;font-weight:600}
.tabs{display:flex;gap:2px;padding:10px 24px 0;border-bottom:1px solid var(--border);flex-wrap:wrap}
.tab{padding:9px 16px;border:1px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;color:var(--mut);font-size:13.5px;font-weight:600}
.tab.on{background:var(--bg-raised);color:var(--text);border-color:var(--border)}.tab:hover{color:var(--text)}
.wrap{display:flex;height:calc(100vh - 212px)}
.list{width:44%;overflow:auto;border-right:1px solid var(--border)}.detail{flex:1;overflow:auto;padding:24px}
.filters{padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;background:var(--bg-raised)}
.filters input{background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:7px;font:inherit;font-size:13px;width:110px}
.filters input:focus{outline:none;border-color:var(--accent)}
.row{padding:13px 16px;border-bottom:1px solid var(--border-soft);cursor:pointer;border-left:3px solid transparent}.row:hover{background:var(--bg-hover)}
.ghead{padding:10px 16px;background:var(--bg-raised);border-bottom:1px solid var(--border);position:sticky;top:0;font-weight:700;font-size:12.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.ghead b{color:var(--text);text-transform:none;letter-spacing:normal;font-size:14.5px;font-family:var(--font-mono)}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.mut{color:var(--mut)}
.k{display:inline-block;min-width:140px;color:var(--mut)}.chk{display:grid;grid-template-columns:140px 1fr;gap:7px 10px;margin:10px 0 6px 4px;font-family:var(--font-mono);font-size:13.5px}
.card{border:1px solid var(--border);border-radius:10px;padding:18px;margin-bottom:14px;background:var(--bg-raised)}
.rz{margin:8px 0;border-left:3px solid var(--fail);padding:7px 0 7px 12px;background:var(--fail-bg);border-radius:0 8px 8px 0}
.lnk{cursor:pointer;color:var(--accent);font-weight:600}.lnk:hover{text-decoration:underline}
code{color:#7a3d00;background:#eceef1;padding:1px 6px;border-radius:5px;font-size:.9em;font-family:var(--font-mono)}.big{font-size:17px;font-weight:700}
.badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;vertical-align:1px;font-family:var(--font-mono)}
.badge.rep{background:var(--warn-bg);color:var(--warn)}
.badge.new{background:var(--fail-bg);color:var(--fail)}
</style></head><body>
<header><h1>Evidence Browser</h1><div class="sub">요약 → 실패(이유·증거) → 영향받은 주장 → 이력(1클릭) → 영수증(맨 마지막) · 정적 파일·서버 없음 · 무결성=생성 시점 스냅샷</div></header>
<div class="dash" id="dash"></div>
<div class="tabs" id="tabs"></div>
<div class="wrap"><div><div class="filters" id="filters">
<input id="fc" placeholder="commit"><input id="fi" placeholder="input sha"><input id="fm" placeholder="model">
<span class="mut" id="count"></span></div><div class="list" id="list"></div></div>
<div class="detail" id="detail"><div class="mut">← 왼쪽에서 실패(탭) 또는 Receipt 선택</div></div></div>
<script id="ar-data" type="application/json">${embedded}</script>
<script>const P=JSON.parse(document.getElementById('ar-data').textContent);const DATA=P.receipts||[],FOLDED=P.folded||DATA,S=P.summary||{},IX=P.indexes||{},HIST=P.histories||{},SUBS=P.subjects||[],HTRUNC=P.historiesTruncated||null,NEWCNT=(typeof P.newFailureCount==='number'?P.newFailureCount:null);
const el=id=>document.getElementById(id);
const esc=x=>String(x==null?'':x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function ok(b){return b===true?'<span class="pass">✅</span>':b===false?'<span class="fail">❌</span>':'<span class="warn">⚠ n/a</span>'}
function st(s){return s==='verified'||s==='valid'?'<span class="pass">✅ '+esc(s)+'</span>':s==='not-found'||s==='mismatch'||s==='invalid'?'<span class="fail">❌ '+esc(s)+'</span>':'<span class="mut">· '+esc(s||'-')+'</span>'}
function cd(l,n,c){return '<div class="cd '+(c==='mut'?'':(c||''))+'"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>'}
const EXC=S.exceptions||{};const excTotal=Object.values(EXC).reduce((a,b)=>a+(b||0),0);
el('dash').innerHTML=cd('전체',S.total||0)+(S.fileCount&&S.fileCount!==S.total?cd('파일',S.fileCount,'mut'):'')+cd('통과',S.pass||0,'pass')+cd('실패',S.fail||0,'fail')+
(NEWCNT!==null?cd('신규 실패',NEWCNT,(NEWCNT?'fail':'pass')):'')+
cd('최다 실패',S.mostFailedCheck||'-')+cd('드리프트',S.driftCount||0,(S.driftCount?'warn':''))+cd('봉인확인실패',S.tamperedCount||0,(S.tamperedCount?'fail':''))+
(excTotal?cd('예외',excTotal,'warn'):'');
if(HTRUNC){const n=document.createElement('div');n.className='mut';n.style.cssText='padding:4px 24px;font-size:12px';n.textContent='이력 사전계산 '+HTRUNC.shown+'/'+HTRUNC.total+'건 — 나머지는 CLI: graph history --claim <지문>';el('dash').after(n)}
const TABS=[['subjects','상태판(Subjects)'],['byCheck','Check별 실패'],['byModel','Model별'],['bySubject','Subject별'],['byCommit','Commit별'],['byReason','Reason별'],['receipts','전체 영수증']];
let cur=Object.keys(IX.byCheck||{}).length?'byCheck':'receipts';
function tabs(){el('tabs').innerHTML=TABS.map(t=>{const n=t[0]==='receipts'?FOLDED.length:t[0]==='subjects'?SUBS.length:Object.keys(IX[t[0]]||{}).length;
return '<span class="tab'+(t[0]===cur?' on':'')+'" data-t="'+t[0]+'">'+t[1]+' ('+n+')</span>'}).join('');
el('tabs').querySelectorAll('.tab').forEach(x=>x.onclick=()=>{cur=x.dataset.t;tabs();renderTab()})}
function renderTab(){if(cur==='receipts'){el('filters').style.display='flex';apply();return}
el('filters').style.display='none';const L=el('list');L.innerHTML='';
if(cur==='subjects'){el('count').textContent='';
if(!SUBS.length){L.innerHTML='<div class="row mut">영수증 없음</div>';return}
SUBS.forEach(s=>{const r=document.createElement('div');r.className='row';
r.innerHTML='<b>'+esc((s.subject||'').slice(0,40))+'</b> '+(s.fail?'<span class="fail">fail '+s.fail+'</span>':'<span class="pass">all pass</span>')+
'<div class="mut">영수증 '+s.receipts+' · pass '+s.pass+' · 실패 이벤트 '+s.failureEvents+(s.tamperedReceipts?' · ⚠ 봉인확인실패 '+s.tamperedReceipts:'')+'</div>';
r.onclick=()=>subjectDetail(s);L.appendChild(r)});return}
const g=IX[cur]||{};const keys=Object.keys(g).sort((a,b)=>g[b].length-g[a].length);
if(!keys.length){L.innerHTML='<div class="row mut">실패 없음 — 전부 PASS</div>';return}
keys.forEach(k=>{const h=document.createElement('div');h.className='ghead';h.innerHTML='<b>'+esc(k)+'</b> <span class="mut">'+g[k].length+'건</span>';L.appendChild(h);
g[k].forEach(e=>{const r=document.createElement('div');r.className='row';
r.innerHTML='<span class="fail">❌ '+esc(e.check)+'</span> <span class="mut">'+esc(e.status)+'</span> · claim #'+e.claimIndex+' '+esc((e.statement||'').slice(0,42))+
(e.isNew?' <span class="badge new">신규</span>':'')+
(e.occurrences>1?' <span class="badge rep">×'+e.occurrences+'</span>':'')+
'<div class="mut">'+esc(e.reason)+' · '+esc(e.verifiedAt||'-')+' · <code>'+esc((e.receiptId||'').slice(0,10))+'…</code></div>';
r.onclick=()=>failureDetail(e);L.appendChild(r)})})}
function wire(){el('detail').querySelectorAll('[data-r]').forEach(x=>x.onclick=()=>{const d=FOLDED.find(y=>y.file===x.dataset.r||(y.allFiles||[]).includes(x.dataset.r));if(d)detail(d)});
el('detail').querySelectorAll('[data-h]').forEach(x=>x.onclick=()=>historyDetail(x.dataset.h))}
function subjectDetail(s){
let h='<div class="card"><div class="big">'+esc(s.subject)+'</div><div class="mut">subject 상태판 — 카운트 롤업(판단 아님)</div>';
h+='<div class="chk"><span class="k">영수증</span>'+s.receipts+'<span class="k">PASS</span><span class="pass">'+s.pass+'</span><span class="k">FAIL</span><span class="'+(s.fail?'fail':'mut')+'">'+s.fail+'</span>'+
'<span class="k">실패 이벤트</span>'+s.failureEvents+'<span class="k">봉인확인실패</span>'+(s.tamperedReceipts?'<span class="fail">'+s.tamperedReceipts+'</span>':'0')+
'<span class="k">기간(자가보고)</span><span class="mut">'+esc(s.firstVerifiedAt||'-')+' ~ '+esc(s.lastVerifiedAt||'-')+'</span></div>';
const ck=Object.entries(s.byCheck||{}).sort((a,b)=>b[1]-a[1]);
if(ck.length)h+='<div class="mut">실패 check: '+ck.map(x=>esc(x[0])+' '+x[1]).join(' · ')+'</div>';
h+='</div>';
const ev=(IX.bySubject||{})[s.subject]||[];
if(ev.length){h+='<div class="card"><b>이 subject 의 실패 '+ev.length+'건</b>';
ev.forEach((e,i)=>{h+='<div class="rz" style="cursor:pointer" data-f="'+i+'"><b class="fail">'+esc(e.check)+'</b> '+esc(e.status)+' · claim#'+e.claimIndex+' '+esc((e.statement||'').slice(0,44))+'</div>'});
h+='</div>'}
h+='<div class="card mut">증감(신규/해소)은 graph diff 의 bySubject · 이 subject 시간축은 CLI: graph history --subject</div>';
el('detail').innerHTML=h;
el('detail').querySelectorAll('[data-f]').forEach(x=>x.onclick=()=>failureDetail(ev[Number(x.dataset.f)]));wire()}
function historyDetail(fp){const tl=HIST[fp]||[];
let h='<div class="card"><div class="big">주장 이력</div><div class="mut">지문 <code>'+esc(fp)+'</code> · 영수증 '+tl.length+'건</div></div>';
if(!tl.length)h+='<div class="card mut">이력 없음</div>';
tl.forEach((t,i)=>{h+='<div class="card"><div><b>['+(i+1)+']</b> '+esc(t.verifiedAt||'-')+' <span class="mut">(자가보고)</span> · '+
(t.verdict==='pass'?'<span class="pass">✓ pass</span>':'<span class="fail">✗ '+esc(t.verdict)+'</span>')+
(t.tampered?' · <span class="fail">⚠ 봉인확인실패</span>':'')+(i===0?' · <span class="mut">첫 등장</span>':'')+'</div>';
if((t.failedChecks||[]).length)h+='<div class="mut">실패: '+t.failedChecks.map(f=>esc(f.check)+'('+esc(f.status)+')').join(' · ')+'</div>';
if(t.changes){const c=t.changes;
if(c.newFailures.length)h+='<div class="fail">+ 새 실패: '+c.newFailures.map(esc).join(' · ')+'</div>';
if(c.resolvedFailures.length)h+='<div class="pass">− 해소: '+c.resolvedFailures.map(esc).join(' · ')+'</div>';
c.statusChanged.forEach(s=>{h+='<div class="warn">~ 상태: '+esc(s.check)+' '+esc(s.base)+' → '+esc(s.head)+'</div>'});
if(c.evidenceChanged.length)h+='<div class="warn">Δ 증거 변화: '+c.evidenceChanged.map(esc).join(' · ')+'</div>';
if(!c.newFailures.length&&!c.resolvedFailures.length&&!c.statusChanged.length&&!c.evidenceChanged.length)h+='<div class="mut">(직전 대비 변화 없음)</div>'}
h+='<div class="mut"><span class="lnk" data-r="'+esc(t.file||'')+'">Receipt 보기(맨 마지막 drill-down) →</span></div></div>'});
h+='<div class="card mut">참고: 시간축=verifiedAt(자가보고) · 해소=그 시점 실패 없음(고침의 증명 아님) · 지문 v1=텍스트 기반(문구 변경=다른 주장 취급)</div>';
el('detail').innerHTML=h;wire()}
function failureDetail(e){const d=DATA.find(x=>x.file===e.file)||{};const c=(d.claims||[])[e.claimIndex-1]||{};
const f=(c.failures||[]).find(x=>x.check===e.check&&x.status===e.status)||{};
let h='<div class="card"><div class="big fail">❌ '+esc(e.check)+' — '+esc(e.status)+'</div>';
h+='<div class="mut">최근 '+esc(e.verifiedAt||'-')+' (자가보고)'+(e.occurrences>1?' · <b class="warn">'+e.occurrences+'개 파일로 반복</b>':'')+'</div>';
h+='<div style="margin-top:8px">이유: '+esc(f.reason||e.reason)+'</div>';
if(f.evidence)h+='<div>증거 — 기대값: <code>'+esc(f.evidence.expected)+'</code> ↔ 실제값: <code>'+esc(f.evidence.actual)+'</code></div>';
if(f.hint)h+='<div class="mut">조치(기계적·표시만): '+esc(f.hint)+'</div>';h+='</div>';
h+='<div class="card"><b>영향받은 주장 #'+e.claimIndex+'</b><div style="margin:4px 0">'+esc(c.statement||e.statement)+'</div><div class="chk">';
(${checkKindsJs}).forEach(k=>{const ch=c.checks||{};if(ch[k]!=null){h+='<span class="k">'+k+'</span>'+st(ch[k])}});h+='</div></div>';
h+='<div class="card">주장 지문 <code>'+esc(e.fingerprint||(c.fingerprint||''))+'</code> · <span class="lnk" data-h="'+esc(e.fingerprint||(c.fingerprint||''))+'">이 주장의 이력 보기 →</span></div>';
h+='<div class="card mut">Receipt <code>'+esc((e.receiptId||'').slice(0,16))+'…</code> · <span class="lnk" data-r="'+esc(e.file||'')+'">Receipt 전체 보기(맨 마지막 drill-down) →</span></div>';
el('detail').innerHTML=h;wire()}
function render(list){const L=el('list');L.innerHTML='';el('count').textContent=list.length+' / '+FOLDED.length;
list.slice().sort((a,b)=>(a.verdict==='fail'?0:1)-(b.verdict==='fail'?0:1)||(b.verifiedAt||'').localeCompare(a.verifiedAt||'')).forEach(d=>{const v=d.verdict==='pass';const div=document.createElement('div');div.className='row';
const nf=(d.claims||[]).reduce((s,c)=>s+((c.failures||[]).length?1:0),0);
div.innerHTML='<span class="'+(v?'pass':'fail')+'">'+(v?'✅ 통과':'❌ 실패')+'</span> <b>'+esc(d.verifiedAt||'-')+'</b>'+(d.occurrences>1?' <span class="badge rep">×'+d.occurrences+'</span>':'')+' ['+esc(d.surface)+'] '+esc((d.subject||'').slice(0,38))+
'<div class="mut">'+(nf?nf+'개 주장 실패 · ':'')+'model='+esc(d.model||'-')+' · commit='+esc(((d.commit||'-')).slice(0,8))+' · <code>'+esc((d.receiptId||'').slice(0,10))+'…</code></div>';
div.onclick=()=>detail(d);L.appendChild(div)})}
function detail(d){const ig=d.integrity||{};let h='<div class="card"><div class="big">'+(d.verdict==='fail'?'<span class="fail">❌ 실패</span>':'<span class="pass">✅ 통과</span>')+
' <span class="mut">'+esc(d.verifiedAt||'-')+' (자가보고)</span></div>';
if(d.occurrences>1)h+='<div class="mut">이 결과는 <b class="warn">'+d.occurrences+'개 파일</b>로 반복 기록됨(같은 입력 재검증 등) — 시각: '+(d.verifiedAtAll||[]).map(esc).join(' · ')+'</div>';
h+='<div class="chk"><span class="k">영수증 무결성</span>'+ok(ig.contentHashOk&&ig.receiptIdOk)+
'<span class="k">내용 해시</span>'+ok(ig.contentHashOk)+'<span class="k">영수증 ID</span>'+ok(ig.receiptIdOk)+
'<span class="k">커밋 존재</span>'+ok(ig.commitRecheck)+'<span class="k">입력 불변</span>'+ok(ig.inputMatch)+'</div>';
h+='<div class="mut">receiptId <code>'+esc(d.receiptId||'')+'</code></div></div>';
const VLABEL={failed:'실패',verified:'검증됨',advisory:'참고'};
(d.claims||[]).forEach((c,i)=>{const ch=c.checks||{};const v=c.verdict;const failed=(c.failures||[]).length;
h+='<div class="card"><div><b>주장 #'+(i+1)+'</b> — '+esc((c.statement||'').slice(0,80))+' → <b class="'+(v==='failed'?'fail':v==='verified'?'pass':'mut')+'">'+esc(VLABEL[v]||v||'')+'</b></div><div class="chk">';
(${checkKindsJs}).forEach(k=>{if(ch[k]!=null){h+='<span class="k">'+k+'</span>'+st(ch[k])}});h+='</div>';
if(failed){h+='<div style="margin-top:8px;font-weight:600">실패 목록</div>';(c.failures||[]).forEach(f=>{
h+='<div class="rz"><b class="fail">'+esc(f.check)+'</b> — '+esc(f.status)+'<div class="mut">이유: '+esc(f.reason)+'</div>'+
(f.evidence?'<div>증거 — 기대값: <code>'+esc(f.evidence.expected)+'</code> · 실제값: <code>'+esc(f.evidence.actual)+'</code></div>':'')+
'<div class="mut">조치(기계적·표시만): '+esc(f.hint)+'</div></div>'})}
if(c.fingerprint)h+='<div class="mut">지문 <code>'+esc((c.fingerprint||'').slice(0,21))+'…</code> · <span class="lnk" data-h="'+esc(c.fingerprint)+'">이력 →</span></div>';
h+='</div>'});
const rel=FOLDED.filter(x=>x.file!==d.file&&x.inputSha&&x.inputSha===d.inputSha&&!(x.receiptId&&d.receiptId&&x.receiptId===d.receiptId));
if(rel.length){h+='<div class="card"><b>같은 입력(same_input) 영수증 '+rel.length+'건(고유)</b>'+
rel.map(x=>'<div class="lnk" data-r="'+esc(x.file||'')+'"><code>'+esc((x.receiptId||'').slice(0,12))+'…</code> '+(x.verdict==='pass'?'✅':'❌')+(x.occurrences>1?' <span class="badge rep">×'+x.occurrences+'</span>':'')+' <span class="mut">'+esc(x.verifiedAt||'')+'</span></div>').join('')+'</div>'}
el('detail').innerHTML=h;wire()}
function apply(){const c=el('fc').value.trim(),i=el('fi').value.trim(),m=el('fm').value.trim();
render(FOLDED.filter(d=>(!c||(d.commit||'').startsWith(c))&&(!i||(d.inputSha||'').startsWith(i))&&(!m||(d.model||'')===m)))}
['fc','fi','fm'].forEach(id=>el(id).addEventListener('input',apply));tabs();renderTab();</script></body></html>`;
}

/**
 * `agent-receipt graph view --dir <d> [--out <html>] [--format json]`
 *  기본: 자체완결 정적 HTML 뷰어(서버 0·Failure-first). --format json: rich JSON = 소비자 API
 *  (summary·indexes·graph{nodes,edges}·failures·receipts — edge 실재 = Evidence Graph).
 */
export function runGraphView(dirArg: string | undefined, outArg: string | undefined, format?: string, viewOpts: { baseDir?: string; match?: string } = {}): never {
  const dir = resolveDir(dirArg);
  const data = buildViewData(dir);
  // --base-dir: 이전 스냅샷 대비 "신규 실패" 마킹(기존 buildGraphDiff 재사용) — 미제공 시 출력 불변.
  const match: DiffMatchMode = viewOpts.match === "fingerprint" ? "fingerprint" : "statement";
  const baseData = viewOpts.baseDir ? buildViewData(resolveDir(viewOpts.baseDir)) : undefined;
  const baseNote = baseData ? ` · 신규(base 대비) 판정=${match}` : "";
  if (format === "json") {
    const newKeys = baseData ? new Set(buildGraphDiff(baseData, data, { match }).newFailures.map((e) => failureKey(e, match))) : null;
    const rawIndexes = buildIndexes(data);
    const indexes = newKeys
      ? (Object.fromEntries(Object.entries(rawIndexes).map(([grp, m]) => [grp, Object.fromEntries(Object.entries(m as Record<string, FailureEvent[]>).map(([k, evs]) => [k, evs.map((e) => (newKeys.has(failureKey(e, match)) ? { ...e, isNew: true } : e))]))])) as unknown as GraphIndexes)
      : rawIndexes;
    const out = JSON.stringify({ dir, summary: buildSummary(data), indexes, graph: buildGraph(data), failures: buildFailures(data), ...(newKeys ? { newFailureCount: newKeys.size } : {}), receipts: data }, null, 2);
    if (outArg) {
      const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
      writeFileSync(outP, out + "\n");
      console.log(`Evidence Graph JSON: ${outArg}  (파일 ${data.length}개 중 고유 ${foldReceipts(data).length}건${baseNote} · 소비자 API · summary+indexes+graph{nodes,edges}+failures+receipts)`);
    } else {
      console.log(out);
    }
    process.exit(0);
  }
  const html = buildGraphHtml(data, { baseData, match });
  if (outArg) {
    const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
    writeFileSync(outP, html);
    console.log(`Evidence Browser: ${outArg}  (파일 ${data.length}개 중 고유 ${foldReceipts(data).length}건${baseNote} · Failure-first · 자체완결 정적 HTML · 서버 0 · 브라우저로 열기)`);
  } else {
    console.log(html);
  }
  process.exit(0);
}

// ── graph failures — 실패 triage 전용(읽기전용·중립·네트워크 0) ──
// 사람이 쓰는 triage 루프: "citation not-found 최근 20개"·"봉인 확인된 실패만" 을 명령 한 줄로.
// 정직: verifiedAt/commit 은 자가보고 — 출력에 라벨. limit 은 "M건 중 N건" 항상 표기(침묵 캡 금지).
export interface FailureFilters {
  check?: string;
  status?: string[]; // 콤마 목록
  subject?: string;
  model?: string;
  commit?: string;
  input?: string;
  sealed?: boolean; // true = 봉인 재검증 통과 영수증의 실패만(tampered 제외)
  since?: string; // ISO — verifiedAt(자가보고) 기준·결측/파싱불가는 제외
}
export function filterFailureEvents(events: FailureEvent[], f: FailureFilters): FailureEvent[] {
  const sinceCt = f.since ? canonTime(f.since) : null;
  return events
    .filter(
      (e) =>
        (!f.check || e.check === f.check) &&
        (!f.status || f.status.includes(e.status)) &&
        (!f.subject || e.subject === f.subject) &&
        (!f.model || e.model === f.model) &&
        (!f.commit || e.commit === f.commit) &&
        (!f.input || e.inputSha === f.input) &&
        (!f.sealed || !e.tampered) &&
        (!sinceCt || (canonTime(e.verifiedAt) ?? "") >= sinceCt),
    )
    .sort(
      (a, b) =>
        cmpStr(canonTime(b.verifiedAt) ?? "", canonTime(a.verifiedAt) ?? "") || // 최신 먼저(자가보고 기준)
        cmpStr(a.file, b.file) || a.claimIndex - b.claimIndex || cmpStr(a.check, b.check),
    );
}
const FAILURE_GROUP_KEYS: Record<string, (e: FailureEvent) => string> = {
  check: (e) => e.check,
  reason: (e) => e.reason,
  subject: (e) => e.subject,
  model: (e) => e.model ?? "(unknown)",
  commit: (e) => e.commit ?? "(none)",
};
/**
 * `agent-receipt graph failures --dir <d> [--by check|reason|subject|model|commit] [필터…] [--limit N] [--format json]`
 *  실패만 빠르게 뽑는 triage. 읽기전용·항상 exit 0(질의이지 게이트 아님 — 게이트는 graph diff).
 */
export function runGraphFailures(dirArg: string | undefined, f: FailureFilters, by?: string, limitArg?: string, format?: string): never {
  const dir = resolveDir(dirArg);
  if (by && !FAILURE_GROUP_KEYS[by]) {
    console.error(`graph failures: --by 는 check|reason|subject|model|commit 중 하나 (받음: ${by})`);
    process.exit(2);
  }
  if (f.since && !canonTime(f.since)) {
    // 침묵 무시 금지 — 파싱 불가한 --since 는 명시적 오류.
    console.error(`graph failures: --since 를 시간으로 못 읽음(ISO-8601 필요): ${f.since}`);
    process.exit(2);
  }
  const all = buildFailureEvents(buildViewData(dir));
  const matched = filterFailureEvents(all, f);
  const limit = limitArg ? Math.max(0, Number(limitArg) || 0) : undefined;
  const shown = limit !== undefined ? matched.slice(0, limit) : matched;

  if (format === "json") {
    const body: Record<string, unknown> = {
      dir, totalFailures: all.length, matched: matched.length, shown: shown.length,
      note: "verifiedAt/commit 은 자가보고 · sealed=봉인 재검증 통과만 · 질의이지 판정 아님",
    };
    if (by) {
      const groups: Record<string, FailureEvent[]> = {};
      for (const e of shown) (groups[FAILURE_GROUP_KEYS[by](e)] ??= []).push(e);
      body.by = by;
      body.groups = groups;
    } else {
      body.events = shown;
    }
    console.log(JSON.stringify(body, null, 2));
    process.exit(0);
  }

  console.log("");
  console.log(line);
  console.log(`실패 triage: ${dir}  (전체 실패 ${all.length}건 → 필터 일치 ${matched.length}건 중 ${shown.length}건 표시)`);
  console.log(line);
  if (!shown.length) console.log("  (일치하는 실패 없음)");
  if (by) {
    const groups = new Map<string, FailureEvent[]>();
    for (const e of shown) {
      const k = FAILURE_GROUP_KEYS[by](e);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    for (const [k, evs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ■ ${by}=${k}  (${evs.length}건)`);
      for (const e of evs) printFailureLine(e);
    }
  } else {
    for (const e of shown) printFailureLine(e);
  }
  console.log(line);
  console.log("  참고: verifiedAt·commit 은 자가보고 값 · 이 명령은 질의(읽기전용)이지 판정이 아님.");
  console.log(line);
  console.log("");
  process.exit(0);
}
function printFailureLine(e: FailureEvent): void {
  console.log(`  ✗ [${e.check}] ${e.status} · ${e.subject.slice(0, 30)} · claim#${e.claimIndex} ${e.statement.slice(0, 40)}${e.tampered ? " · ⚠ 봉인확인실패" : ""}`);
  console.log(`      ${e.reason} · ${e.file} · ${e.verifiedAt ?? "-"} · 지문 ${e.fingerprint.slice(0, 17)}…`);
}

// ── graph diff — 두 집합(base→head) 회귀 비교(읽기전용·결정론) ──
// 매칭 키 = (input.sha256 ∥ subject) + 공백정규화 statement + check — *기록된 텍스트* 기준이지
//   의미적 동일성 아님: 문구가 바뀐 claim 은 "해소+신규" 로 갈라져 보인다(정직 한계·fingerprint 는 후속).
// "해소" = head 에 같은 키의 실패가 없다는 사실이지 고쳐졌다는 증명이 아님.
// 신규 실패 > 0 → exit 1 (집합 비교 사실 — CI 게이트로 쓸 수 있음).
const normWs = (s: string): string => s.replace(/\s+/g, " ").trim();
export type DiffMatchMode = "statement" | "fingerprint";
// statement 모드=(입력sha∥subject)+정규화 statement+check / fingerprint 모드=cfp+check.
// 정직: v1 fingerprint 도 텍스트 기반 — 어느 모드든 문구 변경은 "해소+신규" 로 갈라진다(의미 매칭 아님).
export const failureKey = (e: FailureEvent, match: DiffMatchMode): string =>
  match === "fingerprint"
    ? [e.fingerprint, e.check].join("\u0000")
    : [e.inputSha ?? `subject:${e.subject}`, normWs(e.statement), e.check].join("\u0000"); // NUL 구분자(필드 충돌 방지)
export interface GraphDiffResult {
  match: DiffMatchMode; // 어떤 기준으로 매칭했는지 자기기술
  newFailures: FailureEvent[];
  resolvedFailures: FailureEvent[];
  statusChanged: { check: string; subject: string; statement: string; baseStatus: string; headStatus: string; file: string }[];
  persistingCount: number;
  bySubject: Record<string, { new: number; resolved: number; statusChanged: number; persisting: number }>; // subject 단위 변화량(상태판)
  inputVerdictChanges: { inputSha: string; baseVerdict: string; headVerdict: string }[];
  tamperedBase: number;
  tamperedHead: number;
}
// 같은 input 여러 영수증이면 최신 verifiedAt(자가보고)·file tie-break 의 verdict 를 그 입력의 상태로 본다.
function latestVerdictByInput(rows: ViewRow[]): Map<string, string> {
  const sorted = rows.slice().sort((a, b) => cmpStr(canonTime(a.verifiedAt) ?? "", canonTime(b.verifiedAt) ?? "") || cmpStr(a.file, b.file));
  const m = new Map<string, string>();
  for (const r of sorted) if (r.inputSha) m.set(r.inputSha, r.verdict); // 뒤(=최신)가 덮어씀
  return m;
}
export function buildGraphDiff(baseRows: ViewRow[], headRows: ViewRow[], opts: { sealed?: boolean; match?: DiffMatchMode } = {}): GraphDiffResult {
  const match: DiffMatchMode = opts.match ?? "statement";
  let be = buildFailureEvents(baseRows);
  let he = buildFailureEvents(headRows);
  const tamperedBase = be.filter((e) => e.tampered).length;
  const tamperedHead = he.filter((e) => e.tampered).length;
  if (opts.sealed) {
    be = be.filter((e) => !e.tampered);
    he = he.filter((e) => !e.tampered);
  }
  const bm = new Map(be.map((e) => [failureKey(e, match), e] as const));
  const hm = new Map(he.map((e) => [failureKey(e, match), e] as const));
  const byKeySort = (a: FailureEvent, b: FailureEvent): number => cmpStr(a.check, b.check) || cmpStr(a.subject, b.subject) || cmpStr(a.statement, b.statement);
  const newFailures = [...hm.entries()].filter(([k]) => !bm.has(k)).map(([, e]) => e).sort(byKeySort);
  const resolvedFailures = [...bm.entries()].filter(([k]) => !hm.has(k)).map(([, e]) => e).sort(byKeySort);
  const statusChanged = [...hm.entries()]
    .filter(([k, e]) => bm.has(k) && bm.get(k)!.status !== e.status)
    .map(([k, e]) => ({ check: e.check, subject: e.subject, statement: e.statement, baseStatus: bm.get(k)!.status, headStatus: e.status, file: e.file }))
    .sort((a, b) => cmpStr(a.check, b.check) || cmpStr(a.subject, b.subject) || cmpStr(a.statement, b.statement));
  const persisting = [...hm.entries()].filter(([k, e]) => bm.has(k) && bm.get(k)!.status === e.status).map(([, e]) => e);
  const persistingCount = persisting.length;
  // subject 단위 변화량(상태판) — 카운트만(판단 아님).
  const bySubject: GraphDiffResult["bySubject"] = {};
  const bump = (subj: string, k: keyof GraphDiffResult["bySubject"][string]): void => {
    (bySubject[subj] ??= { new: 0, resolved: 0, statusChanged: 0, persisting: 0 })[k]++;
  };
  for (const e of newFailures) bump(e.subject, "new");
  for (const e of resolvedFailures) bump(e.subject, "resolved");
  for (const c of statusChanged) bump(c.subject, "statusChanged");
  for (const e of persisting) bump(e.subject, "persisting");
  // --sealed 일관성: 입력 verdict 변화도 봉인 확인 영수증만으로(실패 이벤트 필터와 같은 기준).
  const rowTampered = (r: ViewRow): boolean => !r.integrity.contentHashOk || !r.integrity.receiptIdOk;
  const bvRows = opts.sealed ? baseRows.filter((r) => !rowTampered(r)) : baseRows;
  const hvRows = opts.sealed ? headRows.filter((r) => !rowTampered(r)) : headRows;
  const bv = latestVerdictByInput(bvRows);
  const hv = latestVerdictByInput(hvRows);
  const inputVerdictChanges: GraphDiffResult["inputVerdictChanges"] = [];
  for (const [sha, base] of [...bv.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    const head = hv.get(sha);
    if (head !== undefined && head !== base) inputVerdictChanges.push({ inputSha: sha, baseVerdict: base, headVerdict: head });
  }
  return { match, newFailures, resolvedFailures, statusChanged, persistingCount, bySubject, inputVerdictChanges, tamperedBase, tamperedHead };
}
/**
 * `agent-receipt graph diff (--base-dir <d1> --head-dir <d2> | --dir <d> --base-commit <c1> --head-commit <c2>) [--match statement|fingerprint] [--sealed] [--format json]`
 *  회귀 비교: 신규/해소/상태변화/지속/subject별/입력 verdict 변화. 신규 실패>0 → exit 1.
 */
export function runGraphDiff(
  o: { dir?: string; baseDir?: string; headDir?: string; baseCommit?: string; headCommit?: string; sealed?: boolean; match?: string; format?: string },
): never {
  if (o.match && o.match !== "statement" && o.match !== "fingerprint") {
    console.error(`graph diff: --match 는 statement|fingerprint 중 하나 (받음: ${o.match})`);
    process.exit(2);
  }
  let baseRows: ViewRow[];
  let headRows: ViewRow[];
  let baseLabel: string;
  let headLabel: string;
  if (o.baseDir && o.headDir) {
    baseRows = buildViewData(resolveDir(o.baseDir));
    headRows = buildViewData(resolveDir(o.headDir));
    baseLabel = o.baseDir;
    headLabel = o.headDir;
  } else if (o.baseCommit && o.headCommit) {
    const all = buildViewData(resolveDir(o.dir));
    baseRows = all.filter((r) => r.commit === o.baseCommit);
    headRows = all.filter((r) => r.commit === o.headCommit);
    baseLabel = `commit ${o.baseCommit.slice(0, 8)}(자가보고)`;
    headLabel = `commit ${o.headCommit.slice(0, 8)}(자가보고)`;
  } else {
    console.error("graph diff: (--base-dir <d1> --head-dir <d2>) 또는 (--dir <d> --base-commit <c1> --head-commit <c2>) 가 필요합니다.");
    process.exit(2);
  }
  const d = buildGraphDiff(baseRows, headRows, { sealed: o.sealed, match: o.match as DiffMatchMode | undefined });

  if (o.format === "json") {
    console.log(JSON.stringify({
      base: { label: baseLabel, receipts: baseRows.length },
      head: { label: headLabel, receipts: headRows.length },
      sealedOnly: !!o.sealed,
      note: "매칭=기록 텍스트(입력sha∥subject+statement+check) 기준·의미 동일성 아님 · 해소=head 에 같은 키 실패 없음(고침의 증명 아님)",
      ...d,
    }, null, 2));
    process.exit(d.newFailures.length ? 1 : 0);
  }

  console.log("");
  console.log(line);
  console.log(`Evidence Graph diff: base=${baseLabel}(${baseRows.length}건) → head=${headLabel}(${headRows.length}건) · 매칭=${d.match}${o.sealed ? " · 봉인 확인분만" : ""}`);
  console.log(line);
  console.log(`  신규 실패 ${d.newFailures.length} · 해소 ${d.resolvedFailures.length} · 상태변화 ${d.statusChanged.length} · 지속 ${d.persistingCount} · 입력 verdict 변화 ${d.inputVerdictChanges.length}`);
  if (d.tamperedBase || d.tamperedHead) console.log(`  ⚠ 봉인확인실패 실패이벤트: base ${d.tamperedBase} · head ${d.tamperedHead}${o.sealed ? " (제외됨)" : " (포함됨 — --sealed 로 제외 가능)"}`);
  for (const [subj, c] of Object.entries(d.bySubject).sort((a, b) => (b[1].new - a[1].new) || cmpStr(a[0], b[0])))
    console.log(`  subject ${subj.slice(0, 36)}: 신규 ${c.new} · 해소 ${c.resolved} · 상태변화 ${c.statusChanged} · 지속 ${c.persisting}`);
  for (const e of d.newFailures) console.log(`  + 신규: [${e.check}] ${e.status} · ${e.subject.slice(0, 30)} · ${e.statement.slice(0, 40)} · 지문 ${e.fingerprint.slice(0, 17)}…`);
  for (const e of d.resolvedFailures) console.log(`  - 해소: [${e.check}] ${e.status} · ${e.subject.slice(0, 30)} · ${e.statement.slice(0, 40)}`);
  for (const c of d.statusChanged) console.log(`  ~ 상태: [${c.check}] ${c.baseStatus} → ${c.headStatus} · ${c.subject.slice(0, 30)}`);
  for (const v of d.inputVerdictChanges) console.log(`  ⇄ 입력 ${v.inputSha.slice(0, 10)}…: ${v.baseVerdict} → ${v.headVerdict}`);
  console.log(line);
  console.log("  참고: 매칭은 기록 텍스트 기준(문구 변경=해소+신규로 보임) · 해소=고침의 증명 아님 · commit 축은 자가보고.");
  if (d.newFailures.length) console.log("  이력 조회(고정 안내): agent-receipt graph history --dir <d> --claim <지문>");
  console.log(line);
  console.log("");
  process.exit(d.newFailures.length ? 1 : 0);
}

// ── graph history — 같은 주장(fingerprint)/같은 입력(sha256)의 시간축 이력(읽기전용·결정론) ──
// 시간축=verifiedAt(자가보고·라벨)+file tie-break. "변화"=인접 이전 항목 대비(첫 항목=기준점·변화 없음).
// 상태 = 실패 check 만의 맵((fingerprint,check)→{status,evidence}) — verified 로 돌아오면 "해소"로 나타남.
// 키 구분자=공백: fingerprint(cfp1:<hex>)·check(kind 단어)에는 공백이 없어 충돌-안전.
// 정직: 해소=그 시점 영수증에 같은 키 실패가 없다는 사실이지 고침의 증명 아님. fp v1=텍스트 기반.
export interface HistoryChange {
  newFailures: string[]; // "check(status)" 목록
  resolvedFailures: string[];
  statusChanged: { check: string; base: string; head: string }[];
  evidenceChanged: string[]; // 같은 check·같은 status 인데 expected/actual 이 달라진 것
}
export interface HistoryItem {
  receiptId: string;
  file: string;
  subject: string;
  model: string | null;
  commit: string | null; // 자가보고
  verifiedAt: string | null; // 자가보고
  verdict: string;
  tampered: boolean;
  failedChecks: { fingerprint: string; check: string; status: string }[];
  changes: HistoryChange | null; // 첫 항목 null(기준점)
}
type FailState = Map<string, { status: string; evidence: string }>; // key = `${fingerprint} ${check}`
function failState(r: ViewRow, claimFp: string | null): FailState {
  const m: FailState = new Map();
  for (const c of r.claims) {
    if (claimFp && c.fingerprint !== claimFp) continue;
    for (const f of c.failures) {
      m.set(`${c.fingerprint} ${f.check}`, { status: f.status, evidence: JSON.stringify(f.evidence ?? null) });
    }
  }
  return m;
}
export function buildHistory(rows: ViewRow[], sel: { claim?: string; input?: string; subject?: string }): { mode: "claim" | "input" | "subject"; key: string; timeline: HistoryItem[] } {
  const mode = sel.claim ? ("claim" as const) : sel.input ? ("input" as const) : ("subject" as const);
  const key = sel.claim ?? sel.input ?? sel.subject ?? "";
  const involved = rows.filter((r) =>
    mode === "claim" ? r.claims.some((c) => c.fingerprint === sel.claim) : mode === "input" ? r.inputSha === sel.input : r.subject === sel.subject,
  );
  const sorted = involved.slice().sort((a, b) => cmpStr(canonTime(a.verifiedAt) ?? "", canonTime(b.verifiedAt) ?? "") || cmpStr(a.file, b.file));
  const timeline: HistoryItem[] = [];
  let prev: FailState | null = null;
  for (const r of sorted) {
    const cur = failState(r, mode === "claim" ? (sel.claim as string) : null);
    const tampered = !r.integrity.contentHashOk || !r.integrity.receiptIdOk;
    let changes: HistoryChange | null = null;
    if (prev !== null) {
      const label = (k: string, st: string): string => {
        const [fp, check] = k.split(" ");
        return mode === "claim" ? `${check}(${st})` : `${(fp ?? "").slice(0, 12)}… ${check}(${st})`;
      };
      changes = { newFailures: [], resolvedFailures: [], statusChanged: [], evidenceChanged: [] };
      for (const [k, v] of cur) {
        const p = prev.get(k);
        if (!p) changes.newFailures.push(label(k, v.status));
        else if (p.status !== v.status) changes.statusChanged.push({ check: k.split(" ")[1] ?? "", base: p.status, head: v.status });
        else if (p.evidence !== v.evidence) changes.evidenceChanged.push(label(k, v.status));
      }
      for (const [k, v] of prev) if (!cur.has(k)) changes.resolvedFailures.push(label(k, v.status));
      changes.newFailures.sort(cmpStr);
      changes.resolvedFailures.sort(cmpStr);
      changes.evidenceChanged.sort(cmpStr);
      changes.statusChanged.sort((a, b) => cmpStr(a.check, b.check));
    }
    const failedChecks = [...cur.entries()]
      .map(([k, v]) => {
        const [fp, check] = k.split(" ");
        return { fingerprint: fp ?? "", check: check ?? "", status: v.status };
      })
      .sort((a, b) => cmpStr(a.fingerprint, b.fingerprint) || cmpStr(a.check, b.check));
    timeline.push({
      receiptId: r.receiptId, file: r.file, subject: r.subject, model: r.model, commit: r.commit,
      verifiedAt: r.verifiedAt, verdict: r.verdict, tampered, failedChecks, changes,
    });
    prev = cur;
  }
  return { mode, key, timeline };
}
// --claim prefix 해석: 유일하면 채택·모호하면 후보 나열(최대 10·잘림 명시) 후 명시 실패. 침묵 첫매치 금지.
export function resolveFingerprintPrefix(rows: ViewRow[], prefix: string): { fp: string | null; candidates: string[] } {
  const all = new Set<string>();
  for (const r of rows) for (const c of r.claims) if (c.fingerprint.startsWith(prefix)) all.add(c.fingerprint);
  const candidates = [...all].sort(cmpStr);
  return { fp: candidates.length === 1 ? (candidates[0] as string) : null, candidates };
}
/**
 * `agent-receipt graph history --dir <d> (--claim <cfp|접두> | --input <sha256> | --subject <s>) [--format json]`
 *  같은 주장/입력/주제의 시간축 이력 + 인접 대비 변화. 읽기전용·exit 0(질의).
 */
export function runGraphHistory(dirArg: string | undefined, sel: { claim?: string; input?: string; subject?: string }, format?: string): never {
  if ((sel.claim ? 1 : 0) + (sel.input ? 1 : 0) + (sel.subject ? 1 : 0) !== 1) {
    console.error("graph history: --claim <cfp|접두> · --input <sha256> · --subject <s> 중 정확히 하나가 필요합니다.");
    process.exit(2);
  }
  const dir = resolveDir(dirArg);
  const rows = buildViewData(dir);
  let claimFp = sel.claim;
  if (claimFp) {
    const r = resolveFingerprintPrefix(rows, claimFp);
    if (!r.fp) {
      if (!r.candidates.length) {
        console.error(`graph history: fingerprint 없음: ${claimFp}`);
      } else {
        console.error(`graph history: 접두가 모호함(${r.candidates.length}개 일치) — 더 길게 지정하세요:`);
        // 후보별 컨텍스트(subject·최근 시각) — 어느 지문인지 사람이 고를 수 있게(#7 다듬기).
        for (const c of r.candidates.slice(0, 10)) {
          const rowsFor = rows.filter((row) => row.claims.some((cl) => cl.fingerprint === c));
          const subj = rowsFor[0]?.subject ?? "";
          const last = rowsFor.map((row) => row.verifiedAt).filter(Boolean).sort().pop() ?? "-";
          console.error(`  ${c}`);
          console.error(`    └ ${subj.slice(0, 40)} · 최근 ${last}(자가보고) · ${rowsFor.length}건`);
        }
        if (r.candidates.length > 10) console.error(`  (외 ${r.candidates.length - 10}개)`);
        console.error(`  → 위 전체 지문 하나를 복사해 --claim 에 그대로 넣으세요.`);
      }
      process.exit(2);
    }
    claimFp = r.fp;
  }
  const h = buildHistory(rows, claimFp ? { claim: claimFp } : sel.input ? { input: sel.input } : { subject: sel.subject });
  // 관련 edge(이력에 등장한 영수증들 간): 조회용 — receipt 레벨 edge 만.
  const g = buildGraph(h.timeline.length ? rows.filter((r) => h.timeline.some((t) => t.file === r.file)) : []);
  const relEdges = g.edges.filter((e) => e.type === "same_input" || e.type === "same_commit" || e.type === "reverifies");

  if (format === "json") {
    console.log(JSON.stringify({
      dir, mode: h.mode, key: h.key, receipts: h.timeline.length,
      note: "시간축=verifiedAt(자가보고)·해소=그 시점 실패 없음(고침의 증명 아님)·fingerprint v1=텍스트 기반",
      timeline: h.timeline, relatedEdges: relEdges,
    }, null, 2));
    process.exit(0);
  }

  console.log("");
  console.log(line);
  const keyLabel = h.mode === "claim" ? `주장 ${h.key.slice(0, 24)}…` : h.mode === "input" ? `입력 ${h.key.slice(0, 16)}…` : `주제 ${h.key.slice(0, 40)}`;
  console.log(`이력: ${keyLabel}  (영수증 ${h.timeline.length}건 · ${dir})`);
  console.log(line);
  if (!h.timeline.length) console.log("  (해당 이력 없음)");
  h.timeline.forEach((t, i) => {
    console.log(`  [${i + 1}] ${t.verifiedAt ?? "-"} · ${t.verdict === "pass" ? "✓ pass" : "✗ " + t.verdict} · ${t.file}${t.tampered ? " · ⚠ 봉인확인실패" : ""}`);
    console.log(`      subject=${t.subject.slice(0, 30)} · model=${t.model ?? "-"} · commit=${t.commit ? t.commit.slice(0, 8) : "-"}(자가보고)`);
    if (t.failedChecks.length) console.log(`      실패: ${t.failedChecks.map((f) => `${f.check}(${f.status})`).join(" · ")}`);
    if (t.changes) {
      const c = t.changes;
      if (c.newFailures.length) console.log(`      + 새 실패: ${c.newFailures.join(" · ")}`);
      if (c.resolvedFailures.length) console.log(`      - 해소: ${c.resolvedFailures.join(" · ")}`);
      for (const sc of c.statusChanged) console.log(`      ~ 상태: ${sc.check} ${sc.base} → ${sc.head}`);
      if (c.evidenceChanged.length) console.log(`      Δ 증거 변화: ${c.evidenceChanged.join(" · ")}`);
      if (!c.newFailures.length && !c.resolvedFailures.length && !c.statusChanged.length && !c.evidenceChanged.length) console.log("      (직전 대비 변화 없음)");
    }
  });
  if (relEdges.length) {
    const cnt: Record<string, number> = {};
    for (const e of relEdges) cnt[e.type] = (cnt[e.type] ?? 0) + 1;
    console.log(`  관련 관계선: ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  }
  console.log(line);
  console.log("  참고: 시간축=verifiedAt(자가보고) · 해소=그 시점 실패 없음(고침의 증명 아님) · fingerprint v1=텍스트 기반(문구 변경=다른 주장 취급).");
  console.log(line);
  console.log("");
  process.exit(0);
}
