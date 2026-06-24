import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { listReceipts, parseReceiptJson, criticalTouchedCount } from "./receiptStore.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * `agent-receipt dashboard [--out <path>]` — receipts/*.json 으로 단일 static HTML 생성.
 * 외부 CDN/network 없음(self-contained). 기본 out = .agent-guard/dashboard.html (verify tool-output 제외 대상).
 */
export function runDashboard(outArg: string | undefined, cwd: string = process.cwd()): never {
  const entries = listReceipts(cwd).filter((e) => e.name.endsWith(".json"));
  const rows = entries
    .map((e) => {
      const o = parseReceiptJson(e.abs) ?? {};
      const status = o.ok === true ? "PASS" : o.ok === false ? "FAIL" : "?";
      const cls = o.ok === true ? "pass" : o.ok === false ? "fail" : "";
      const mag = o.magnitude
        ? `${o.magnitude.filesChanged ?? 0} files, +${o.magnitude.added ?? 0}/-${o.magnitude.deleted ?? 0}, ${o.magnitude.newFiles ?? 0} new`
        : "-";
      return (
        `<tr><td>${esc(e.name)}</td>` +
        `<td class="${cls}">${status}</td>` +
        `<td>${esc(o.contractId ?? "?")}</td>` +
        `<td>${esc(o.timestamp ?? "?")}</td>` +
        `<td>${esc(mag)}</td>` +
        `<td>${criticalTouchedCount(o)}</td>` +
        `<td class="hash">${esc(o.contentHash ?? "?")}</td></tr>`
      );
    })
    .join("\n");

  // 타임라인/추세(Tier 2): receipt 별 PASS/FAIL 색칠(오래된→최신) + pass-rate. 인라인만(CDN/network 0).
  const CELL_CAP = 500; // 색칸 상한(대형 비대 방지)
  const oks = entries.map((e) => parseReceiptJson(e.abs)?.ok);
  const passN = oks.filter((o) => o === true).length;
  const failN = oks.filter((o) => o === false).length;
  const rate = entries.length ? Math.round((passN / entries.length) * 100) : 0;
  const cells = [...oks.slice(0, CELL_CAP)]
    .reverse()
    .map((o) => {
      const c = o === true ? "#0a0" : o === false ? "#c00" : "#bbb";
      const t = o === true ? "PASS" : o === false ? "FAIL" : "?";
      return `<span class="cell" style="background:${c}" title="${t}"></span>`;
    })
    .join("");
  const capNote = oks.length > CELL_CAP ? ` (최근 ${CELL_CAP}개만 표시 / 전체 ${oks.length})` : "";

  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<title>agent-receipt dashboard</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#222}
  h1{font-size:1.2rem} .meta{color:#666;font-size:.85rem}
  table{border-collapse:collapse;width:100%;margin-top:1rem}
  th,td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left;font-size:.85rem}
  th{background:#f5f5f5} .pass{color:#0a0;font-weight:600} .fail{color:#c00;font-weight:600}
  .hash{font-family:monospace;font-size:.75rem;color:#666;word-break:break-all}
  .timeline{margin-top:1rem;line-height:1}
  .cell{display:inline-block;width:10px;height:16px;margin:0 1px;border-radius:2px;vertical-align:middle}
</style></head><body>
<h1>agent-receipt — AI Work Receipts</h1>
<p class="meta">${entries.length} receipt(s) · local-first, no network · generated ${new Date().toISOString()}</p>
<div class="timeline"><strong>Timeline</strong> (old → new)${capNote}: ${cells || "(none)"}</div>
<p class="meta">PASS ${passN} · FAIL ${failN} · pass-rate ${rate}%</p>
<table>
<thead><tr><th>file</th><th>result</th><th>contract</th><th>timestamp</th><th>magnitude</th><th>critical</th><th>contentHash</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">(no receipts — run <code>agent-receipt receipt</code>)</td></tr>'}
</tbody></table>
</body></html>
`;

  const rel = outArg ?? join(".agent-guard", "dashboard.html");
  const out = isAbsolute(rel) ? rel : join(cwd, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`dashboard 생성: ${rel} (${entries.length} receipts)`);
  console.log("  브라우저로 열어 확인하세요. (기본 위치 .agent-guard/dashboard.html 는 verify 가 제외합니다.)");
  process.exit(0);
}
