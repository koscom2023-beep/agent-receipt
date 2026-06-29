import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, type Receipt } from "./receipt.js";
import { redactText } from "./redact.js";
import { LIMIT_NOTE } from "./disclosure.js";

// ── share-proof v0 (council B) — 외주사가 클라이언트에 보내는 로컬 self-contained HTML 증거 ──
// 원칙: network 0(외부 CDN/img/script src 없음 — 오프라인 열람·유출 0) · 모든 동적 문자열 esc(injection 방어)
//        · 정직 라벨(제목=AI Work Receipt·tamper-evident·컴플라이언스 보장 아님) · buildReceipt 재사용(새 계산 0).
// 범위 밖(hard-stop): cloud/hosted 검증 링크·제3자 anchor·서명(다음 단계).

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 순수함수: Receipt → 고객 전달용 self-contained HTML(외부 리소스 0). */
export function toProofHtml(r: Receipt): string {
  const pass = r.ok;
  const statusTxt = pass ? "PASS ✓" : "FAIL ✗";
  const statusColor = pass ? "#0a7d33" : "#c00";
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  const critTxt = hit.length ? hit.map((c) => esc(c.glob)).join(", ") : "none touched";

  const actionRows =
    r.actions && r.actions.length
      ? r.actions.map((a) => `<li><span class="flag">${esc(a.flag)}</span> <code>${esc(a.path ?? a.host ?? "")}</code></li>`).join("\n")
      : "";
  const s = r.actionsSummary;
  const beyondGit =
    r.actions && r.actions.length && s
      ? `<section>
  <h2>Beyond-git actions (capture)</h2>
  <p class="meta">What the agent actually did that <strong>git does not show</strong>:</p>
  <ul class="actions">${actionRows}</ul>
  <p class="contrast"><strong>git saw: ${s.gitVisible}</strong> &nbsp;⟷&nbsp; <strong>actions recorded: ${s.total}</strong></p>
  <p class="meta">Values are never stored — paths/hosts/classification only. Capture scope = since the last <code>capture reset</code>.</p>
</section>`
      : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Work Receipt — ${esc(r.contractId)}</title>
<style>
  body{font:15px/1.6 system-ui,-apple-system,sans-serif;margin:0;background:#f7f7f8;color:#1a1a1a}
  .wrap{max-width:680px;margin:2rem auto;background:#fff;border:1px solid #e3e3e6;border-radius:12px;padding:2rem 2.2rem}
  h1{font-size:1.25rem;margin:0 0 .2rem} h2{font-size:1rem;margin:1.4rem 0 .4rem}
  .status{display:inline-block;font-weight:700;font-size:1.1rem;color:${statusColor};margin:.4rem 0 1rem}
  .meta{color:#666;font-size:.85rem;margin:.2rem 0}
  table{border-collapse:collapse;width:100%;margin:.4rem 0;font-size:.9rem}
  td{border-bottom:1px solid #eee;padding:.35rem .2rem;vertical-align:top}
  td.k{color:#666;width:38%} code{font-family:ui-monospace,Menlo,monospace;font-size:.82rem;word-break:break-all}
  .hash{font-family:ui-monospace,monospace;font-size:.75rem;color:#555;word-break:break-all}
  ul.actions{margin:.3rem 0;padding-left:1.1rem} ul.actions li{margin:.15rem 0}
  .flag{display:inline-block;background:#fff3cd;color:#7a5b00;border-radius:4px;padding:0 .35rem;font-size:.75rem;font-weight:600}
  .contrast{background:#f1f4ff;border-radius:8px;padding:.5rem .7rem;font-size:.95rem}
  footer{margin-top:1.6rem;padding-top:1rem;border-top:1px solid #eee;color:#888;font-size:.78rem}
</style></head><body>
<div class="wrap">
  <h1>AI Work Receipt</h1>
  <p class="meta">Scope evidence for <code>${esc(r.contractId)}</code>${r.title ? ` — ${esc(r.title)}` : ""}</p>
  <div class="status">${statusTxt}</div>
  <table>
    <tr><td class="k">Result</td><td>${pass ? "Stayed within agreed scope" : "Out-of-scope / contract violation — see details"}</td></tr>
    <tr><td class="k">Branch</td><td><code>${esc(r.branch.current)}</code>${r.branch.expected ? ` (expected <code>${esc(r.branch.expected)}</code>)` : ""}</td></tr>
    <tr><td class="k">Commit (HEAD)</td><td><code>${esc(r.headHash)}</code></td></tr>
    <tr><td class="k">Files changed</td><td>${r.touched.length} (${r.magnitude.filesChanged} files, +${r.magnitude.added} / -${r.magnitude.deleted} lines, ${r.magnitude.newFiles} new)</td></tr>
    <tr><td class="k">Critical paths</td><td>${critTxt}</td></tr>
    <tr><td class="k">Checks</td><td>${r.checks.length ? r.checks.map((c) => `${esc(c.name)} ${c.ok ? "OK" : "✗"}`).join(", ") : "none"}</td></tr>
    <tr><td class="k">Integrity (contentHash)</td><td class="hash">${esc(r.contentHash)}</td></tr>
    <tr><td class="k">Generated</td><td>${esc(r.timestamp)}</td></tr>
  </table>
  ${beyondGit}
  <footer>
    ${esc(LIMIT_NOTE)}<br>
    git-based evidence — <strong>tamper-evident, not non-forgeable</strong>. This is evidence for review, <strong>not a compliance guarantee</strong>. Generated locally; no data left the machine.
  </footer>
</div>
</body></html>
`;
}

/**
 * `agent-receipt share-proof [--out <path>] [--redact]` — 현재 상태로 receipt 를 만들어
 * 클라이언트 전달용 self-contained HTML 로 저장. exit = ok ? 0 : 1.
 */
export function runShareProof(
  contract: Contract,
  contractPath: string | undefined,
  outArg: string | undefined,
  redact: boolean = false,
): never {
  const r = buildReceipt(contract, contractPath);
  let html = toProofHtml(r);
  if (redact) html = redactText(html).text;
  const stamp = r.timestamp.replace(/[:.]/g, "-");
  const rel = outArg ?? join(".agent-guard", `proof-${stamp}.html`);
  const out = isAbsolute(rel) ? rel : join(process.cwd(), rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`share-proof 생성: ${rel} (${r.ok ? "PASS" : "FAIL"})`);
  console.log("  → 브라우저로 열어 확인 후 클라이언트에게 이 파일을 보내세요(로컬 증거·외부 전송 0).");
  console.log(`  ${LIMIT_NOTE}`);
  process.exit(r.ok ? 0 : 1);
}
