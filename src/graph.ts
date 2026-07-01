import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { replayVerificationReceipt } from "./vreceipt.js";

const line = "─".repeat(56);

// ── Evidence Graph — 조회/색인 레이어 (L6 v1) ──
// 쌓인 Verification Receipt 를 commit/input/model/receiptId 로 질의한다(읽기전용·중립).
// 정직: v1 은 조회/색인이지 receipt 간 관계(edge-DAG)는 아직 아니다 — 그건 L6 후속.
// 집계는 pass/fail 카운트(중립·점수/판단 아님·insights 범주).

export interface VRRow {
  receiptId: string;
  subject: string;
  verdict: string;
  surface: string;
  model: string | null;
  commit: string | null;
  inputSha: string | null;
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
interface ViewRow {
  receiptId: string; subject: string; verdict: string; surface: string;
  model: string | null; commit: string | null; inputSha: string | null;
  integrity: { contentHashOk: boolean; receiptIdOk: boolean; inputMatch: boolean | null; commitRecheck: boolean | null };
  claims: unknown;
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
        integrity,
        claims: r.results ?? [],
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildGraphHtml(data: ViewRow[]): string {
  // 검증가능성 중심(예쁨보다) — 임베드 JSON + vanilla JS 필터·drill-down. 외부 리소스 0·서버 0.
  const embedded = JSON.stringify(data).replace(/</g, "\\u003c"); // < → \\u003c: </script> 주입 방지(유효 JSON)
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Evidence Graph — Verification Receipts</title><style>
body{margin:0;background:#0e1117;color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
header{padding:14px 18px;border-bottom:1px solid #21262d}h1{margin:0;font-size:15px}.sub{color:#8b949e;font-size:11px;margin-top:4px}
.wrap{display:flex;gap:0;height:calc(100vh - 58px)}
.list{width:46%;overflow:auto;border-right:1px solid #21262d}
.detail{flex:1;overflow:auto;padding:16px}
.filters{padding:8px 12px;border-bottom:1px solid #21262d;display:flex;gap:6px;flex-wrap:wrap}
.filters input{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:4px 6px;border-radius:4px;font:inherit}
.row{padding:8px 12px;border-bottom:1px solid #161b22;cursor:pointer}.row:hover{background:#161b22}
.pass{color:#3fb950}.fail{color:#f85149}.warn{color:#d29922}.mut{color:#8b949e}
.k{display:inline-block;min-width:130px}.chk{display:grid;grid-template-columns:120px 1fr;gap:2px 10px;margin:6px 0 6px 12px}
.card{border:1px solid #21262d;border-radius:6px;padding:12px;margin-bottom:12px}
code{color:#79c0ff}.big{font-size:15px;font-weight:700}
</style></head><body>
<header><h1>Evidence Graph — Verification Receipts</h1><div class="sub">정적·서버 없음 · 검증 가능성 중심 · 무결성은 생성 시점 replay 스냅샷</div></header>
<div class="wrap"><div><div class="filters">
<input id="fc" placeholder="commit"><input id="fi" placeholder="input sha"><input id="fm" placeholder="model">
<span class="mut" id="count"></span></div><div class="list" id="list"></div></div>
<div class="detail" id="detail"><div class="mut">← 왼쪽에서 Receipt 선택</div></div></div>
<script id="ar-data" type="application/json">${embedded}</script>
<script>const DATA=JSON.parse(document.getElementById('ar-data').textContent);
const el=id=>document.getElementById(id);
function ok(b){return b===true?'<span class="pass">✅</span>':b===false?'<span class="fail">❌</span>':'<span class="warn">⚠</span>'}
function status(s){return s==='verified'||s==='valid'?'<span class="pass">✅ '+s+'</span>':s==='not-found'||s==='mismatch'||s==='invalid'?'<span class="fail">❌ '+s+'</span>':'<span class="mut">· '+(s||'-')+'</span>'}
function render(list){const L=el('list');L.innerHTML='';el('count').textContent=list.length+' / '+DATA.length;
list.forEach((d,i)=>{const v=d.verdict==='pass';const div=document.createElement('div');div.className='row';
div.innerHTML='<span class="'+(v?'pass':'fail')+'">'+(v?'✅ PASS':'❌ FAIL')+'</span> <code>'+(d.receiptId||'').slice(0,12)+'…</code> ['+d.surface+'] '+(d.subject||'').slice(0,40)+
'<div class="mut">model='+(d.model||'-')+' · commit='+((d.commit||'-')).slice(0,8)+' · input='+((d.inputSha||'-')).slice(0,8)+'</div>';
div.onclick=()=>detail(d);L.appendChild(div)})}
function detail(d){const ig=d.integrity||{};let h='<div class="card"><div class="big">Verification Receipt</div>';
h+='<div class="chk"><span class="k">Receipt Integrity</span>'+ok(ig.contentHashOk&&ig.receiptIdOk);
h+='<span class="k">Content Hash Match</span>'+ok(ig.contentHashOk);
h+='<span class="k">Receipt ID Match</span>'+ok(ig.receiptIdOk);
h+='<span class="k">Commit Exists</span>'+ok(ig.commitRecheck);
h+='<span class="k">Input Unchanged</span>'+ok(ig.inputMatch)+'</div>';
h+='<div class="mut">receiptId <code>'+(d.receiptId||'')+'</code></div></div>';
(d.claims||[]).forEach((c,i)=>{const ch=c.checks||{};const v=c.verdict;
h+='<div class="card"><div><b>Claim #'+(i+1)+'</b> — '+((c.statement||'')).slice(0,60)+'</div><div class="chk">';
['citation','number','date','hash','signature','link'].forEach(k=>{if(ch[k]!=null){h+='<span class="k">'+k+'</span>'+status(ch[k])}});
h+='</div><div>→ <b class="'+(v==='failed'?'fail':v==='verified'?'pass':'mut')+'">'+(v||'').toUpperCase()+'</b></div></div>'});
el('detail').innerHTML=h}
function apply(){const c=el('fc').value.trim(),i=el('fi').value.trim(),m=el('fm').value.trim();
render(DATA.filter(d=>(!c||(d.commit||'').startsWith(c))&&(!i||(d.inputSha||'').startsWith(i))&&(!m||(d.model||'')===m)))}
['fc','fi','fm'].forEach(id=>el(id).addEventListener('input',apply));render(DATA);</script></body></html>`;
}

/** `agent-receipt graph view --dir <d> [--out <html>]` — 자체완결 정적 HTML 뷰어(서버 0). */
export function runGraphView(dirArg: string | undefined, outArg: string | undefined): never {
  const dir = resolveDir(dirArg);
  const data = buildViewData(dir);
  const html = buildGraphHtml(data);
  if (outArg) {
    const outP = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
    writeFileSync(outP, html);
    console.log(`Evidence Graph 뷰어: ${outArg}  (${data.length}건 · 자체완결 정적 HTML · 서버 0 · 브라우저로 열기)`);
  } else {
    console.log(html);
  }
  process.exit(0);
}
