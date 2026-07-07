import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listReceipts } from "./receiptStore.js";
import type { Receipt } from "./receipt.js";
import type { SessionVerdict } from "./verdict.js";
import { LIMIT_NOTE } from "./disclosure.js";

// v0.21 결정8 (council 2026-07-07) — 로컬 receipt inbox: 쌓인 Work Receipt 를 한 화면으로.
// 원칙: 읽기전용·중립 카운트(판단 0)·no-cloud 불변 — 이 JSON 계약(inbox/1)은 hosted 를 owner 가
//   후일 결정해도 그대로 API 스키마가 되게 설계(재작업 0·Architect 결정). 결정론: asOf = 최신 영수증
//   타임스탬프(Date.now 아님) — 같은 디렉터리 → 같은 산출.
// 구버전(0.17 이전·판정 없음) 영수증은 "판정 없음(none)" 버킷 — 실측된 케이스(promptia)를 그대로 수용.

export interface InboxRow {
  file: string;
  timestamp: string;
  contractId: string;
  kind: string | null;
  verdict: SessionVerdict | null; // null = 구버전(판정 없음)
  ok: boolean;
  touched: number;
  denied: number;
  outOfScope: number;
  critical: number; // criticalPaths 중 실제 touched 있는 glob 수
}
export interface InboxData {
  schemaVersion: "inbox/1";
  asOf: string | null; // 최신 영수증 timestamp(결정론 기준점)
  windowDays: number | null; // null = --all
  rows: InboxRow[]; // timestamp 내림차순
  summary: {
    total: number;
    scanned: number; // 창 적용 전 전체(잘림 자백)
    broken: number; // 파싱 실패(침묵 금지 — 카운트로 자백)
    byVerdict: Record<"PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "INCOMPLETE" | "none", number>;
    deniedTouched: number;
    criticalTouched: number;
  };
}

export const INBOX_DEFAULT_DAYS = 90; // Perf 상한 — 측정 전 추가 최적화 금지(--all 로 해제)

export function buildInbox(cwd: string, opts: { days?: number | null } = {}): InboxData {
  const entries = listReceipts(cwd).filter((e) => e.name.endsWith(".json"));
  const rows: InboxRow[] = [];
  let broken = 0;
  for (const e of entries) {
    try {
      const r = JSON.parse(readFileSync(e.abs, "utf8")) as Receipt;
      if (typeof r.contentHash !== "string" || typeof r.timestamp !== "string") {
        broken++;
        continue;
      }
      rows.push({
        file: e.rel,
        timestamp: r.timestamp,
        contractId: r.contractId ?? "(unknown)",
        kind: r.session?.kind ?? null,
        verdict: r.verdict?.verdict ?? null,
        ok: !!r.ok,
        touched: r.touched?.length ?? 0,
        denied: r.deniedHits?.length ?? 0,
        outOfScope: r.outOfScope?.length ?? 0,
        critical: (r.criticalPaths ?? []).filter((c) => c.touched.length).length,
      });
    } catch {
      broken++;
    }
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  const asOf = rows[0]?.timestamp ?? null;
  const scanned = rows.length;
  const days = opts.days === undefined ? INBOX_DEFAULT_DAYS : opts.days;
  let windowed = rows;
  if (days !== null && asOf) {
    const cutoff = new Date(new Date(asOf).getTime() - days * 86400_000).toISOString();
    windowed = rows.filter((r) => r.timestamp >= cutoff);
  }
  const byVerdict = { PASS: 0, PASS_WITH_WARNINGS: 0, FAIL: 0, INCOMPLETE: 0, none: 0 };
  let deniedTouched = 0;
  let criticalTouched = 0;
  for (const r of windowed) {
    byVerdict[r.verdict ?? "none"]++;
    if (r.denied > 0) deniedTouched++;
    if (r.critical > 0) criticalTouched++;
  }
  return {
    schemaVersion: "inbox/1",
    asOf,
    windowDays: days,
    rows: windowed,
    summary: { total: windowed.length, scanned, broken, byVerdict, deniedTouched, criticalTouched },
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 정적 HTML(내부 도구 — evidence-browser 형제·외부 리소스 0·데이터 임베드+바닐라 필터).
export function buildInboxHtml(d: InboxData): string {
  const rowsJson = JSON.stringify(d.rows).replace(/</g, "\\u003c");
  const s = d.summary;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-receipt inbox</title>
<style>
 body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f7f7f8;color:#1a1a1a}
 .wrap{max-width:960px;margin:1.5rem auto;padding:0 1rem}
 h1{font-size:1.1rem} .meta{color:#666;font-size:.85rem}
 .cards{display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0}
 .card{background:#fff;border:1px solid #e3e3e6;border-radius:8px;padding:.4rem .7rem;font-size:.85rem}
 table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3e3e6;font-size:.85rem}
 th,td{border-bottom:1px solid #eee;padding:.35rem .5rem;text-align:left}
 th{background:#fafafa;color:#555} code{font:.8rem ui-monospace,monospace}
 .v-PASS{color:#0a7d33}.v-FAIL{color:#c00}.v-PASS_WITH_WARNINGS{color:#8a6d00}.v-INCOMPLETE,.v-none{color:#777}
 select,label{font-size:.85rem;margin-right:.6rem}
</style></head><body><div class="wrap">
<h1>agent-receipt inbox — Work Receipts</h1>
<p class="meta">기준(asOf): ${esc(d.asOf ?? "(없음)")} · 창: ${d.windowDays === null ? "전체" : `최근 ${d.windowDays}일`} · 표시 ${s.total} / 스캔 ${s.scanned}${s.broken ? ` · <b>파싱 실패 ${s.broken}건</b>` : ""} — 읽기전용·중립 카운트(판단 아님)</p>
<div class="cards">
 <span class="card">PASS ${s.byVerdict.PASS}</span><span class="card">⚠️ ${s.byVerdict.PASS_WITH_WARNINGS}</span>
 <span class="card">FAIL ${s.byVerdict.FAIL}</span><span class="card">◌ ${s.byVerdict.INCOMPLETE}</span>
 <span class="card">판정 없음(구버전) ${s.byVerdict.none}</span>
 <span class="card">금지경로 접촉 세션 ${s.deniedTouched}</span><span class="card">고위험경로 세션 ${s.criticalTouched}</span>
</div>
<div>
 <label>판정 <select id="f-v"><option value="">전체</option><option>PASS</option><option>PASS_WITH_WARNINGS</option><option>FAIL</option><option>INCOMPLETE</option><option value="none">판정 없음</option></select></label>
 <label><input type="checkbox" id="f-d"> 금지경로 접촉만</label>
 <label><input type="checkbox" id="f-c"> 고위험경로만</label>
 <label>kind <select id="f-k"><option value="">전체</option></select></label>
</div>
<table><thead><tr><th>시각</th><th>판정</th><th>kind</th><th>변경</th><th>denied</th><th>범위밖</th><th>고위험</th><th>파일</th></tr></thead><tbody id="tb"></tbody></table>
<p class="meta">${esc(LIMIT_NOTE)}</p>
<script>
const rows=${rowsJson};
const kinds=[...new Set(rows.map(r=>r.kind).filter(Boolean))].sort();
const fk=document.getElementById("f-k");kinds.forEach(k=>{const o=document.createElement("option");o.textContent=k;fk.appendChild(o)});
const tb=document.getElementById("tb");
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}
function render(){
 const v=document.getElementById("f-v").value,d=document.getElementById("f-d").checked,c=document.getElementById("f-c").checked,k=fk.value;
 tb.innerHTML=rows.filter(r=>{
  const rv=r.verdict??"none";
  return (!v||rv===v)&&(!d||r.denied>0)&&(!c||r.critical>0)&&(!k||r.kind===k);
 }).map(r=>{const rv=r.verdict??"none";return \`<tr><td>\${esc(r.timestamp)}</td><td class="v-\${rv}">\${rv==="none"?"판정 없음":esc(rv)}</td><td>\${esc(r.kind??"—")}</td><td>\${r.touched}</td><td>\${r.denied}</td><td>\${r.outOfScope}</td><td>\${r.critical}</td><td><code>\${esc(r.file)}</code></td></tr>\`}).join("");
}
["f-v","f-d","f-c","f-k"].forEach(id=>document.getElementById(id).addEventListener("change",render));
render();
</script>
</div></body></html>
`;
}

/** `agent-receipt inbox [--out <html>] [--format json] [--days N | --all]` — 쌓인 영수증 상태판(읽기전용). exit 0. */
export function runInbox(opts: { out?: string; format?: string; days?: string; all?: boolean }, cwd: string = process.cwd()): never {
  const days = opts.all ? null : opts.days !== undefined ? Math.max(1, Number(opts.days) || INBOX_DEFAULT_DAYS) : INBOX_DEFAULT_DAYS;
  const d = buildInbox(cwd, { days });
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(d, null, 2) + "\n");
    process.exit(0);
  }
  if (opts.out) {
    const out = isAbsolute(opts.out) ? opts.out : join(cwd, opts.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buildInboxHtml(d));
    console.log(`inbox 생성: ${opts.out} (표시 ${d.summary.total}/스캔 ${d.summary.scanned}${d.summary.broken ? ` · 파싱실패 ${d.summary.broken}` : ""})`);
    process.exit(0);
  }
  const s = d.summary;
  console.log("");
  console.log("─".repeat(56));
  console.log(`agent-receipt inbox — Work Receipts (asOf ${d.asOf ?? "없음"} · ${d.windowDays === null ? "전체" : `최근 ${d.windowDays}일`})`);
  console.log("─".repeat(56));
  console.log(`총 ${s.total}건(스캔 ${s.scanned}${s.broken ? ` · 파싱실패 ${s.broken}` : ""}) · PASS ${s.byVerdict.PASS} · ⚠️ ${s.byVerdict.PASS_WITH_WARNINGS} · FAIL ${s.byVerdict.FAIL} · ◌ ${s.byVerdict.INCOMPLETE} · 판정없음(구버전) ${s.byVerdict.none}`);
  console.log(`금지경로 접촉 세션 ${s.deniedTouched} · 고위험경로 세션 ${s.criticalTouched}  (중립 카운트 — 판단 아님)`);
  for (const r of d.rows.slice(0, 10)) {
    console.log(`  ${r.timestamp}  ${(r.verdict ?? "판정없음").padEnd(19)} touched ${r.touched} denied ${r.denied}  ${r.file}`);
  }
  if (d.rows.length > 10) console.log(`  … 외 ${d.rows.length - 10}건 — HTML: agent-receipt inbox --out .agent-guard/inbox.html`);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
