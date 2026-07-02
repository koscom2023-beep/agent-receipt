import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

function aggregate(rows: VRRow[]): { pass: number; fail: number; byModel: Record<string, { pass: number; fail: number }> } {
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
 *  쌓인 Verification Receipt 를 질의. 읽기전용·중립 카운트. --format json = UI/기계용. exit 0.
 */
export function runGraphQuery(dirArg: string | undefined, f: GraphFilters, format?: string): never {
  const dir = resolveDir(dirArg);
  const all = loadReceipts(dir);
  const rows = queryReceipts(all, f);
  const agg = aggregate(rows);

  if (format === "json") {
    console.log(JSON.stringify({ dir, total: all.length, matched: rows.length, rows, aggregate: agg }, null, 2));
    process.exit(0);
  }

  console.log("");
  console.log(line);
  console.log(`Evidence Graph 조회: ${dir}  (총 ${all.length}건 중 ${rows.length}건 일치)`);
  console.log(line);
  for (const r of rows) {
    console.log(`  ${r.verdict === "pass" ? "✓" : "✗"} ${r.receiptId.slice(0, 12)}… [${r.surface}] ${r.subject.slice(0, 40)}`);
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
  checks: Record<string, string | null>;
  failures: FailureReason[]; // Reason 객체(check→reason→evidence→hint)
}
function enrichClaims(results: unknown): EnrichedClaim[] {
  if (!Array.isArray(results)) return [];
  return results.map((c) => {
    const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const checks = (o.checks && typeof o.checks === "object" ? o.checks : {}) as Record<string, string | null>;
    const evMap = (o.evidence && typeof o.evidence === "object" ? o.evidence : {}) as Record<string, { expected?: unknown; actual?: unknown }>;
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
      statement: typeof o.statement === "string" ? o.statement : "",
      verdict: typeof o.verdict === "string" ? o.verdict : "",
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
}

// Dashboard 요약(생성시점 집계·중립 카운트).
export interface GraphSummary {
  total: number; pass: number; fail: number;
  byModel: Record<string, { pass: number; fail: number }>;
  checkFailures: Record<string, number>;
  mostFailedCheck: string | null;
  driftCount: number; // inputMatch===false 또는 commitRecheck===false
  tamperedCount: number; // contentHashOk/receiptIdOk 불일치
}
export function buildSummary(rows: ViewRow[]): GraphSummary {
  let pass = 0, fail = 0, driftCount = 0, tamperedCount = 0;
  const byModel: Record<string, { pass: number; fail: number }> = {};
  const checkFailures: Record<string, number> = {};
  for (const r of rows) {
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
  return { total: rows.length, pass, fail, byModel, checkFailures, mostFailedCheck: entries[0]?.[0] ?? null, driftCount, tamperedCount };
}

// Failure-first: 실패 receipt 별 reason + 영향받은 claim.
export interface FailureEntry { receiptId: string; subject: string; reasons: string[]; affectedClaims: number[] }
export function buildFailures(rows: ViewRow[]): FailureEntry[] {
  return rows
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
      return { receiptId: r.receiptId, subject: r.subject, reasons: [...reasons], affectedClaims };
    });
}

// FailureEvent = 실패 1건(claim×실패check)을 flat 정규화 — indexes 의 source.
export interface FailureEvent {
  receiptId: string;
  file: string; // 안정 식별자(receiptId 결측/중복 파일에도 정확 귀속)
  subject: string;
  model: string | null;
  commit: string | null;
  claimIndex: number;
  statement: string;
  check: string;
  status: string;
  reason: string;
}
export function buildFailureEvents(rows: ViewRow[]): FailureEvent[] {
  const out: FailureEvent[] = [];
  for (const r of rows) {
    r.claims.forEach((c, i) => {
      c.failures.forEach((f) => {
        out.push({ receiptId: r.receiptId, file: r.file, subject: r.subject, model: r.model, commit: r.commit, claimIndex: i + 1, statement: c.statement, check: f.check, status: f.status, reason: f.reason });
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
export interface GraphNode {
  id: string;
  type: "receipt" | "claim" | "check";
  [k: string]: unknown;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: "asserts" | "checked_by" | "same_input" | "same_commit" | "reverifies";
  basis: string; // 결정론 근거 자기기술(무엇으로 이 엣지를 만들었나)
  tier: "verified" | "reported"; // 근거의 신뢰 계층(provenance 계층화와 같은 규율)
}
const canonTime = (v: string | null): string | null => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0); // 코드포인트·로케일 비의존

export function buildGraph(rows: ViewRow[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  interface Ent { row: ViewRow; rid: string; ct: string | null; times: string[]; occurrences: number }
  const byRid = new Map<string, Ent>();
  for (const row of rows) {
    const rid = row.receiptId ? `receipt:${row.receiptId}` : `receipt:file:${row.file}`;
    const ct = canonTime(row.verifiedAt);
    const prev = byRid.get(rid);
    if (!prev) {
      byRid.set(rid, { row, rid, ct, times: row.verifiedAt ? [row.verifiedAt] : [], occurrences: 1 });
      continue;
    }
    prev.occurrences++;
    if (row.verifiedAt) prev.times.push(row.verifiedAt);
    // 최신 verifiedAt 행 유지(동률이면 file 코드포인트 큰 쪽 — readdir 순서 비의존 tie-break)
    if ((cmpStr(ct ?? "", prev.ct ?? "") || cmpStr(row.file, prev.row.file)) > 0) {
      prev.row = row;
      prev.ct = ct;
    }
  }
  const uniq = [...byRid.values()].sort(
    (a, b) => cmpStr(a.ct ?? "", b.ct ?? "") || cmpStr(a.rid, b.rid) || cmpStr(a.row.file, b.row.file),
  );
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const isTampered = (e: Ent): boolean => !e.row.integrity.contentHashOk || !e.row.integrity.receiptIdOk;
  const inputRehashed = (e: Ent): boolean => e.row.integrity.inputMatch === true;
  for (const e of uniq) {
    const r = e.row;
    const node: GraphNode = {
      id: e.rid, type: "receipt", subject: r.subject, verdict: r.verdict, surface: r.surface,
      model: r.model, commit: r.commit, inputSha: r.inputSha, verifiedAt: r.verifiedAt, file: r.file,
    };
    if (isTampered(e)) node.tampered = true; // 봉인 확인 실패 — 숨기지 않고 표시
    if (e.occurrences > 1) {
      node.occurrences = e.occurrences; // 접힌 파일 수(기록 보존)
      node.verifiedAtAll = e.times.slice().sort((x, y) => cmpStr(canonTime(x) ?? x, canonTime(y) ?? y));
    }
    nodes.push(node);
    r.claims.forEach((c, i) => {
      const cid = `${e.rid}/claim/${i + 1}`;
      nodes.push({ id: cid, type: "claim", statement: c.statement, verdict: c.verdict });
      edges.push({ from: e.rid, to: cid, type: "asserts", basis: "영수증 파일에서 직접 읽은 포함관계(구조 사실)", tier: "verified" });
      for (const [kind, stt] of Object.entries(c.checks)) {
        if (stt == null) continue;
        const kid = `${cid}/check/${kind}`;
        nodes.push({ id: kid, type: "check", check: kind, status: stt });
        edges.push({ from: cid, to: kid, type: "checked_by", basis: "영수증 파일에서 직접 읽은 checks 기록(구조 사실)", tier: "verified" });
      }
    });
  }
  const groupBy = (key: (r: ViewRow) => string | null): Map<string, Ent[]> => {
    const m = new Map<string, Ent[]>();
    for (const e of uniq) {
      const k = key(e.row);
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
        edges.push({
          from: g[j].rid, to: g[i].rid, type: "same_input",
          basis: rehashedBoth
            ? "input.sha256 동일 — 양쪽 입력 파일 재해시로 확인(inputMatch)"
            : "input.sha256 동일 — 영수증 기재값 기준(입력 재해시 불가/미일치 포함)",
          tier: rehashedBoth ? "verified" : "reported",
        });
      }
    for (let i = 0; i + 1 < g.length; i++) {
      const a = g[i], b = g[i + 1];
      if (a.ct && b.ct && b.ct > a.ct)
        edges.push({
          from: b.rid, to: a.rid, type: "reverifies",
          basis: "같은 input.sha256 + verifiedAt 시간순 — verifiedAt 은 자가보고 타임스탬프(파생의 증명 아님)",
          tier: "reported",
        });
    }
  }
  for (const g of groupBy((r) => r.commit).values()) {
    for (let i = 0; i < g.length; i++)
      for (let j = i + 1; j < g.length; j++)
        edges.push({
          from: g[j].rid, to: g[i].rid,
          type: "same_commit", basis: "provenance.reported.commit 동일(자가보고)", tier: "reported",
        });
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
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildGraphHtml(data: ViewRow[]): string {
  // Evidence Browser: Failure-first 순서 — Dashboard → Failures(indexes 탭: Check별/Model별/…) →
  //   Reason(→Evidence) → Affected Claim → Receipt 상세(맨 마지막 drill-down).
  // 임베드 JSON + vanilla JS. 외부 리소스 0·서버 0(share-proof 패턴·이식 리포트).
  const embedded = JSON.stringify({
    receipts: data, summary: buildSummary(data), indexes: buildIndexes(data), failures: buildFailures(data),
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evidence Browser — Verification Receipts</title><style>
body{margin:0;background:#0e1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
header{padding:12px 18px;border-bottom:1px solid #21262d}h1{margin:0;font-size:15px}.sub{color:#8b949e;font-size:11px;margin-top:3px}
.dash{display:flex;gap:10px;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid #21262d}
.cd{border:1px solid #21262d;border-radius:8px;padding:8px 14px;min-width:78px}.cd .n{font-size:20px;font-weight:700}.cd .l{font-size:10px;color:#8b949e;text-transform:uppercase}
.tabs{display:flex;gap:2px;padding:8px 18px 0;border-bottom:1px solid #21262d;flex-wrap:wrap}
.tab{padding:6px 12px;border:1px solid #21262d;border-bottom:none;border-radius:6px 6px 0 0;cursor:pointer;color:#8b949e}
.tab.on{background:#161b22;color:#e6edf3;font-weight:700}.tab:hover{color:#e6edf3}
.wrap{display:flex;height:calc(100vh - 190px)}
.list{width:46%;overflow:auto;border-right:1px solid #21262d}.detail{flex:1;overflow:auto;padding:16px}
.filters{padding:8px 12px;border-bottom:1px solid #21262d;display:flex;gap:6px;flex-wrap:wrap}
.filters input{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:4px 6px;border-radius:4px;font:inherit}
.row{padding:8px 12px;border-bottom:1px solid #161b22;cursor:pointer}.row:hover{background:#161b22}
.ghead{padding:8px 12px;background:#161b22;border-bottom:1px solid #21262d;position:sticky;top:0}
.pass{color:#3fb950}.fail{color:#f85149}.warn{color:#d29922}.mut{color:#8b949e}
.k{display:inline-block;min-width:130px}.chk{display:grid;grid-template-columns:120px 1fr;gap:2px 10px;margin:6px 0 6px 12px}
.card{border:1px solid #21262d;border-radius:6px;padding:12px;margin-bottom:12px}
.rz{margin:4px 0 4px 10px;border-left:2px solid #f85149;padding-left:8px}
.lnk{cursor:pointer;color:#58a6ff}.lnk:hover{text-decoration:underline}
code{color:#79c0ff}.big{font-size:15px;font-weight:700}
</style></head><body>
<header><h1>Evidence Browser</h1><div class="sub">Dashboard → Failures(Reason·Evidence) → Affected Claims → Receipt(맨 마지막 drill-down) · 정적·서버 0 · 무결성=생성 시점 replay 스냅샷</div></header>
<div class="dash" id="dash"></div>
<div class="tabs" id="tabs"></div>
<div class="wrap"><div><div class="filters" id="filters">
<input id="fc" placeholder="commit"><input id="fi" placeholder="input sha"><input id="fm" placeholder="model">
<span class="mut" id="count"></span></div><div class="list" id="list"></div></div>
<div class="detail" id="detail"><div class="mut">← 왼쪽에서 실패(탭) 또는 Receipt 선택</div></div></div>
<script id="ar-data" type="application/json">${embedded}</script>
<script>const P=JSON.parse(document.getElementById('ar-data').textContent);const DATA=P.receipts||[],S=P.summary||{},IX=P.indexes||{};
const el=id=>document.getElementById(id);
const esc=x=>String(x==null?'':x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function ok(b){return b===true?'<span class="pass">✅</span>':b===false?'<span class="fail">❌</span>':'<span class="warn">⚠ n/a</span>'}
function st(s){return s==='verified'||s==='valid'?'<span class="pass">✅ '+s+'</span>':s==='not-found'||s==='mismatch'||s==='invalid'?'<span class="fail">❌ '+s+'</span>':'<span class="mut">· '+(s||'-')+'</span>'}
function cd(l,n,c){return '<div class="cd"><div class="n '+(c||'')+'">'+n+'</div><div class="l">'+l+'</div></div>'}
el('dash').innerHTML=cd('Total',S.total||0)+cd('PASS',S.pass||0,'pass')+cd('FAIL',S.fail||0,'fail')+
cd('Most Failed',S.mostFailedCheck||'-')+cd('Drift',S.driftCount||0,(S.driftCount?'warn':''))+cd('Tampered',S.tamperedCount||0,(S.tamperedCount?'fail':''));
const TABS=[['byCheck','Check별 실패'],['byModel','Model별'],['bySubject','Subject별'],['byCommit','Commit별'],['byReason','Reason별'],['receipts','Receipts']];
let cur=Object.keys(IX.byCheck||{}).length?'byCheck':'receipts';
function tabs(){el('tabs').innerHTML=TABS.map(t=>{const n=t[0]!=='receipts'?Object.keys(IX[t[0]]||{}).length:DATA.length;
return '<span class="tab'+(t[0]===cur?' on':'')+'" data-t="'+t[0]+'">'+t[1]+' ('+n+')</span>'}).join('');
el('tabs').querySelectorAll('.tab').forEach(x=>x.onclick=()=>{cur=x.dataset.t;tabs();renderTab()})}
function renderTab(){if(cur==='receipts'){el('filters').style.display='flex';apply();return}
el('filters').style.display='none';const L=el('list');L.innerHTML='';
const g=IX[cur]||{};const keys=Object.keys(g).sort((a,b)=>g[b].length-g[a].length);
if(!keys.length){L.innerHTML='<div class="row mut">실패 없음 — 전부 PASS</div>';return}
keys.forEach(k=>{const h=document.createElement('div');h.className='ghead';h.innerHTML='<b>'+esc(k)+'</b> <span class="mut">'+g[k].length+'건</span>';L.appendChild(h);
g[k].forEach(e=>{const r=document.createElement('div');r.className='row';
r.innerHTML='<span class="fail">❌ '+esc(e.check)+'</span> <span class="mut">'+esc(e.status)+'</span> · claim #'+e.claimIndex+' '+esc((e.statement||'').slice(0,42))+
'<div class="mut">'+esc(e.reason)+' · <code>'+esc((e.receiptId||'').slice(0,10))+'…</code></div>';
r.onclick=()=>failureDetail(e);L.appendChild(r)})})}
function wire(){el('detail').querySelectorAll('[data-r]').forEach(x=>x.onclick=()=>{const d=DATA.find(y=>y.file===x.dataset.r);if(d)detail(d)})}
function failureDetail(e){const d=DATA.find(x=>x.file===e.file)||{};const c=(d.claims||[])[e.claimIndex-1]||{};
const f=(c.failures||[]).find(x=>x.check===e.check&&x.status===e.status)||{};
let h='<div class="card"><div class="big fail">❌ '+esc(e.check)+' — '+esc(e.status)+'</div>';
h+='<div style="margin-top:6px">Reason: '+esc(f.reason||e.reason)+'</div>';
if(f.evidence)h+='<div>Evidence — expected: <code>'+esc(f.evidence.expected)+'</code> ↔ actual: <code>'+esc(f.evidence.actual)+'</code></div>';
if(f.hint)h+='<div class="mut">Hint (mechanical · 표시만): '+esc(f.hint)+'</div>';h+='</div>';
h+='<div class="card"><b>Affected Claim #'+e.claimIndex+'</b><div style="margin:4px 0">'+esc(c.statement||e.statement)+'</div><div class="chk">';
['citation','number','date','hash','signature','link'].forEach(k=>{const ch=c.checks||{};if(ch[k]!=null){h+='<span class="k">'+k+'</span>'+st(ch[k])}});h+='</div></div>';
h+='<div class="card mut">Receipt <code>'+esc((e.receiptId||'').slice(0,16))+'…</code> · <span class="lnk" data-r="'+esc(e.file||'')+'">Receipt 전체 보기(맨 마지막 drill-down) →</span></div>';
el('detail').innerHTML=h;wire()}
function render(list){const L=el('list');L.innerHTML='';el('count').textContent=list.length+' / '+DATA.length;
list.slice().sort((a,b)=>(a.verdict==='fail'?0:1)-(b.verdict==='fail'?0:1)).forEach(d=>{const v=d.verdict==='pass';const div=document.createElement('div');div.className='row';
const nf=(d.claims||[]).reduce((s,c)=>s+((c.failures||[]).length?1:0),0);
div.innerHTML='<span class="'+(v?'pass':'fail')+'">'+(v?'✅ PASS':'❌ FAIL')+'</span> <code>'+esc((d.receiptId||'').slice(0,12))+'…</code> ['+esc(d.surface)+'] '+esc((d.subject||'').slice(0,38))+
'<div class="mut">'+(nf?nf+' claim(s) failed · ':'')+'model='+esc(d.model||'-')+' · commit='+esc(((d.commit||'-')).slice(0,8))+'</div>';
div.onclick=()=>detail(d);L.appendChild(div)})}
function detail(d){const ig=d.integrity||{};let h='<div class="card"><div class="big">'+(d.verdict==='fail'?'<span class="fail">❌ FAILED</span>':'<span class="pass">✅ PASSED</span>')+'</div>';
h+='<div class="chk"><span class="k">Receipt Integrity</span>'+ok(ig.contentHashOk&&ig.receiptIdOk)+
'<span class="k">Content Hash</span>'+ok(ig.contentHashOk)+'<span class="k">Receipt ID</span>'+ok(ig.receiptIdOk)+
'<span class="k">Commit Exists</span>'+ok(ig.commitRecheck)+'<span class="k">Input Unchanged</span>'+ok(ig.inputMatch)+'</div>';
h+='<div class="mut">receiptId <code>'+esc(d.receiptId||'')+'</code></div></div>';
(d.claims||[]).forEach((c,i)=>{const ch=c.checks||{};const v=c.verdict;const failed=(c.failures||[]).length;
h+='<div class="card"><div><b>Claim #'+(i+1)+'</b> — '+esc((c.statement||'').slice(0,80))+' → <b class="'+(v==='failed'?'fail':v==='verified'?'pass':'mut')+'">'+esc((v||'').toUpperCase())+'</b></div><div class="chk">';
['citation','number','date','hash','signature','link'].forEach(k=>{if(ch[k]!=null){h+='<span class="k">'+k+'</span>'+st(ch[k])}});h+='</div>';
if(failed){h+='<div style="margin-top:6px">Failures:</div>';(c.failures||[]).forEach(f=>{
h+='<div class="rz"><b class="fail">'+esc(f.check)+'</b> — '+esc(f.status)+'<div class="mut">Reason: '+esc(f.reason)+'</div>'+
(f.evidence?'<div>Evidence — expected: <code>'+esc(f.evidence.expected)+'</code> · actual: <code>'+esc(f.evidence.actual)+'</code></div>':'')+
'<div class="mut">Hint (mechanical · 표시만): '+esc(f.hint)+'</div></div>'})}
h+='</div>'});
const seenR={};const rel=DATA.filter(x=>x.file!==d.file&&x.inputSha&&x.inputSha===d.inputSha&&!(x.receiptId&&d.receiptId&&x.receiptId===d.receiptId))
.filter(x=>{const k=x.receiptId||x.file;if(seenR[k])return 0;seenR[k]=1;return 1});
if(rel.length){h+='<div class="card"><b>같은 입력(same_input) 영수증 '+rel.length+'건</b>'+
rel.map(x=>'<div class="lnk" data-r="'+esc(x.file||'')+'"><code>'+esc((x.receiptId||'').slice(0,12))+'…</code> '+(x.verdict==='pass'?'✅':'❌')+' <span class="mut">'+esc(x.verifiedAt||'')+'</span></div>').join('')+'</div>'}
el('detail').innerHTML=h;wire()}
function apply(){const c=el('fc').value.trim(),i=el('fi').value.trim(),m=el('fm').value.trim();
render(DATA.filter(d=>(!c||(d.commit||'').startsWith(c))&&(!i||(d.inputSha||'').startsWith(i))&&(!m||(d.model||'')===m)))}
['fc','fi','fm'].forEach(id=>el(id).addEventListener('input',apply));tabs();renderTab();</script></body></html>`;
}

/**
 * `agent-receipt graph view --dir <d> [--out <html>] [--format json]`
 *  기본: 자체완결 정적 HTML 뷰어(서버 0·Failure-first). --format json: rich JSON = 소비자 API
 *  (summary·indexes·graph{nodes,edges}·failures·receipts — edge 실재 = Evidence Graph).
 */
export function runGraphView(dirArg: string | undefined, outArg: string | undefined, format?: string): never {
  const dir = resolveDir(dirArg);
  const data = buildViewData(dir);
  if (format === "json") {
    const out = JSON.stringify({ dir, summary: buildSummary(data), indexes: buildIndexes(data), graph: buildGraph(data), failures: buildFailures(data), receipts: data }, null, 2);
    if (outArg) {
      const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
      writeFileSync(outP, out + "\n");
      console.log(`Evidence Graph JSON: ${outArg}  (${data.length}건 · 소비자 API · summary+indexes+graph{nodes,edges}+failures+receipts)`);
    } else {
      console.log(out);
    }
    process.exit(0);
  }
  const html = buildGraphHtml(data);
  if (outArg) {
    const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
    writeFileSync(outP, html);
    console.log(`Evidence Browser: ${outArg}  (${data.length}건 · Failure-first · 자체완결 정적 HTML · 서버 0 · 브라우저로 열기)`);
  } else {
    console.log(html);
  }
  process.exit(0);
}
