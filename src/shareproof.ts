import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, type Receipt } from "./receipt.js";
import { splitActionsForDisplay } from "./capture.js";
import { redactText } from "./redact.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { listReceipts, loadRekorAnchor, type RekorAnchor } from "./receiptStore.js";

// ── share-proof v0 (council B) — 외주사가 클라이언트에 보내는 로컬 self-contained HTML 증거 ──
// 원칙: 자동로드 0(외부 CDN/img/script "src" 없음 — 열람만으로 유출 0) · 모든 동적 문자열 esc(injection 방어)
//        · 정직 라벨(제목=AI Work Receipt·tamper-evident·컴플라이언스 보장 아님) · buildReceipt 재사용(새 계산 0).
// Stage 1b(6차 council): 영수증을 Rekor 에 앵커한 경우(.rekor.json sidecar 존재)만 *클릭형* 검증 링크(href)를 추가.
//   href 는 사용자가 직접 누를 때만 외부와 통신 → '열람만으로 유출 0' 원칙 유지. 앵커 없으면 출력은 기존과 바이트 동일.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 순수함수: Receipt(+선택 Rekor 앵커) → 고객 전달용 self-contained HTML(자동로드 리소스 0). 앵커 미전달 시 출력은 앵커 도입 전과 바이트 동일. */
export function toProofHtml(r: Receipt, anchor?: RekorAnchor | null): string {
  const pass = r.ok;
  const statusTxt = pass ? "PASS ✓" : "FAIL ✗";
  const statusColor = pass ? "#0a7d33" : "#c00";
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  const critTxt = hit.length ? hit.map((c) => esc(c.glob)).join(", ") : "none touched";

  // 표시 필터(council 5 #2): 무서운 행위만 개별 노출, 일반 read/command 는 건수로 접음(증거 데이터 total 은 그대로).
  const split = r.actions && r.actions.length ? splitActionsForDisplay(r.actions) : { notable: [], mutedCount: 0 };
  const actionRows = split.notable
    .map((a) => `<li><span class="flag">${esc(a.flag)}</span> <code>${esc(a.path ?? a.host ?? "")}</code></li>`)
    .join("\n");
  const mutedLi = split.mutedCount ? `\n  <li class="muted">+ ${split.mutedCount} routine read/command (recorded, hidden)</li>` : "";
  const s = r.actionsSummary;
  const beyondGit =
    r.actions && r.actions.length && s
      ? `<section>
  <h2>Beyond-git actions (capture)</h2>
  <p class="meta">Notable actions the agent took that <strong>git does not show</strong>:</p>
  <ul class="actions">${actionRows || `<li class="muted">none notable</li>`}${mutedLi}</ul>
  <p class="contrast"><strong>git saw: ${s.gitVisible}</strong> &nbsp;⟷&nbsp; <strong>actions recorded: ${s.total}</strong></p>
  <p class="meta">Values are never stored — paths/hosts/classification only. Capture scope = since the last <code>capture reset</code>.</p>
</section>`
      : "";

  // Stage 1b: Rekor 앵커가 있으면 *클릭형* 제3자 검증 섹션. 기존 CSS 클래스만 사용(전역 style 불변) → 앵커 없으면 ""(바이트 동일).
  const anchorSection = anchor
    ? `
  <section>
  <h2>Third-party anchor (Rekor)</h2>
  <p class="contrast">🔗 <a href="${esc(anchor.verifyUrl)}">Verify in the public transparency log</a> — anyone can confirm this receipt existed at this time <strong>without trusting the issuer</strong>.</p>
  <table>
    <tr><td class="k">Rekor logIndex</td><td><code>${esc(String(anchor.logIndex ?? "?"))}</code></td></tr>
    <tr><td class="k">Entry UUID</td><td><code>${esc(anchor.uuid)}</code></td></tr>
  </table>
  <p class="meta">Seals <strong>time &amp; existence</strong> via a third party — not a keyless (identity) proof.</p>
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
  li.muted{color:#9a9a9a;font-size:.8rem;list-style:none;margin-left:-.6rem}
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
  ${beyondGit}${anchorSection}
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
// 공통 쓰기: Receipt → HTML 파일. fresh build / 저장 receipt 양쪽이 재사용. anchor 는 저장 receipt 경로에서만 조회됨(fresh 는 항상 없음 → 바이트 동일).
function writeProof(r: Receipt, outArg: string | undefined, redact: boolean, anchor?: RekorAnchor | null): never {
  let html = toProofHtml(r, anchor);
  if (redact) html = redactText(html).text;
  const stamp = (r.timestamp ?? "receipt").replace(/[:.]/g, "-");
  const rel = outArg ?? join(".agent-guard", `proof-${stamp}.html`);
  const out = isAbsolute(rel) ? rel : join(process.cwd(), rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`share-proof 생성: ${rel} (${r.ok ? "PASS" : "FAIL"})`);
  console.log("  → 브라우저로 열어 확인 후 클라이언트에게 이 파일을 보내세요(로컬 증거·외부 전송 0).");
  console.log(`  ${LIMIT_NOTE}`);
  process.exit(r.ok ? 0 : 1);
}

/** 현재 상태로 receipt 를 새로 만들어 렌더(계약 필요). 저장 receipt 가 없을 때의 fallback. */
export function runShareProof(contract: Contract, contractPath: string | undefined, outArg: string | undefined, redact: boolean = false): never {
  writeProof(buildReceipt(contract, contractPath), outArg, redact);
}

/** 저장된 receipt(.json)가 하나라도 있나 — cli 가 "기본=최신 렌더 vs fresh build" 분기에 사용. */
export function latestReceiptExists(cwd: string = process.cwd()): boolean {
  return listReceipts(cwd).some((e) => e.name.endsWith(".json"));
}

/**
 * `agent-receipt share-proof [--receipt <path>]` — 저장된 receipt 를 렌더(기본 최신).
 * done/receipt 시점 그대로 클라이언트에 증명. 파싱/형식 실패 = exit 2(계약 불필요).
 */
export function runShareProofFromSaved(
  receiptPath: string | undefined,
  outArg: string | undefined,
  redact: boolean,
  cwd: string = process.cwd(),
): never {
  let abs: string;
  if (receiptPath) {
    abs = isAbsolute(receiptPath) ? receiptPath : join(cwd, receiptPath);
    if (!existsSync(abs)) {
      console.error(`share-proof: receipt 파일 없음: ${receiptPath}`);
      process.exit(2);
    }
  } else {
    const latest = listReceipts(cwd).find((e) => e.name.endsWith(".json"));
    if (!latest) {
      console.error("share-proof: 저장된 receipt 없음 — 먼저 `agent-receipt done`/`receipt` 실행하거나 --receipt <경로> 지정.");
      process.exit(2);
    }
    abs = latest.abs;
  }
  let r: Receipt;
  try {
    r = JSON.parse(readFileSync(abs, "utf8")) as Receipt;
  } catch {
    console.error(`share-proof: receipt 파싱 실패(JSON 아님): ${abs}`);
    process.exit(2);
  }
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
    console.error(`share-proof: receipt 형식이 아님: ${abs}`);
    process.exit(2);
  }
  // Stage 1b: 이 영수증이 Rekor 에 앵커됐으면(.rekor.json sidecar) 검증 링크를 임베드. 없으면 null → 기존과 바이트 동일.
  writeProof(r, outArg, redact, loadRekorAnchor(abs));
}
