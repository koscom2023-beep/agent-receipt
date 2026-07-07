import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, renderReceipt, type Receipt } from "./receipt.js";
import { splitActionsForDisplay, COVERED_TOOLS } from "./capture.js";
import { redactText, redactJsonText } from "./redact.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { listReceipts, loadRekorAnchor, loadSavedReceipt, rekorAnchorPath, type RekorAnchor } from "./receiptStore.js";
import { renderVerdictLine, renderContractLine, renderContractProse } from "./verdict.js";
import { buildViewData, buildSummary } from "./graph.js";
import { costLines } from "./cost.js";
import { summarizeCurrentSession } from "./transcript.js";
import { publicKeyRelPath } from "./keys.js";
import { loadCaptureRecords } from "./capture.js";
import { reviewStatusFor, type ReviewRecord } from "./approve.js";
import * as g from "./git.js";

// ── share-proof v0 (council B) — 외주사가 클라이언트에 보내는 로컬 self-contained HTML 증거 ──
// 원칙: 자동로드 0(외부 CDN/img/script "src" 없음 — 열람만으로 유출 0) · 모든 동적 문자열 esc(injection 방어)
//        · 정직 라벨(제목=AI Work Receipt·tamper-evident·컴플라이언스 보장 아님) · buildReceipt 재사용(새 계산 0).
// Stage 1b(6차 council): 영수증을 Rekor 에 앵커한 경우(.rekor.json sidecar 존재)만 *클릭형* 검증 링크(href)를 추가.
//   href 는 사용자가 직접 누를 때만 외부와 통신 → '열람만으로 유출 0' 원칙 유지.
// P2 v0.19 (council D5·D6): 3축 탭 1페이지(Change/Evidence/Cost — D7 확정 축과 동일) + proof bundle.
//   · 탭은 **CSS radio 만**(script 0 유지 — 보안 테스트가 <script 를 금지) · @media print 에서 전 패널 펼침(DA-3:
//     "탭이 증거를 숨김" 수용) · CSS 미지원 환경 폴백 = 전부 보임 · 빈 탭은 침묵 대신 "포함 안 됨 + 포함 방법" 정직 표기.
//   · Evidence/Cost 내용은 opt-in 플래그(--evidence-dir/--with-cost)로만 채움 — 기본 IO 불변.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── P2 D5: Evidence 탭 데이터 — vreceipts 디렉터리의 중립 롤업(graph 와 같은 함수 재사용·판단 없음) ──
export interface ProofEvidence {
  receipts: number;
  pass: number;
  fail: number;
  exceptions: number; // 봉인확인실패·날조근거결정·출처도달실패 합(동결 3종)
  mostFailedCheck: string | null;
}
export function buildProofEvidence(dir: string): ProofEvidence | null {
  try {
    const rows = buildViewData(dir);
    if (!rows.length) return null;
    const s = buildSummary(rows);
    const exceptions = Object.values(s.exceptions).reduce((a, b) => a + b, 0);
    return { receipts: s.total, pass: s.pass, fail: s.fail, exceptions, mostFailedCheck: s.mostFailedCheck };
  } catch {
    return null; // 깨진/비어있는 디렉터리 = 포함 안 함(가짜 요약 금지)
  }
}
export interface ProofExtras {
  evidence?: ProofEvidence | null;
  evidenceDirLabel?: string | null; // 표기용(어느 디렉터리를 요약했나)
  costLines?: string[] | null; // 생성 시점 세션 비용 줄(cost.ts costLines 재사용)
  timeline?: ProofTimeline | null; // v0.20 결정3 — 세션 타임라인(결정론 렌더)
  client?: boolean; // v0.20 결정5 — 축약판(요약+판정+타임라인 중심·기술 상세 생략·'전체판 별도' 자백)
  review?: ReviewRecord | null; // 배치A-2 — 검토 기록(사이드카·자가보고) 표면화
}

// ── v0.20 결정3: 세션 타임라인 — capture 레코드(ts·seq·op) 결정론 / capture 없으면 git 커밋 시각 축약판 ──
export interface ProofTimelineEvent {
  ts: string;
  label: string; // 값 미포함(경로/호스트/분류/커밋제목만)
}
export interface ProofTimeline {
  source: "capture" | "git"; // 정직 라벨 — 어느 원천의 타임라인인가
  events: ProofTimelineEvent[]; // 시간순
  folded: number; // 상한으로 접힌 이전 이벤트 수(0=전부 표시) — 인쇄에도 명시
}
export const TIMELINE_MAX_EVENTS = 500; // Perf 상한 — 대형 세션 방어(측정 전 추가 최적화 금지)
export function buildProofTimeline(cwd: string = process.cwd()): ProofTimeline | null {
  try {
    const records = loadCaptureRecords();
    if (records.length) {
      const events = records.map((r) => ({
        ts: r.ts,
        label: `${r.op}${r.path ? ` ${r.path}` : r.host ? ` ${r.host}` : r.cmdKind ? ` (${r.cmdKind})` : ""}`,
      }));
      const folded = Math.max(0, events.length - TIMELINE_MAX_EVENTS);
      return { source: "capture", events: events.slice(-TIMELINE_MAX_EVENTS), folded };
    }
  } catch {
    /* capture 읽기 실패 = git 축약판으로(가짜 타임라인 금지) */
  }
  try {
    const commits = g.recentCommits(20);
    if (!commits.length) return null;
    return {
      source: "git",
      events: commits.reverse().map((c) => ({ ts: c.ts, label: `commit ${c.hash} — ${c.subject}` })),
      folded: 0,
    };
  } catch {
    return null;
  }
}

/** 순수함수: Receipt(+선택 Rekor 앵커·선택 extras) → 고객 전달용 self-contained HTML(자동로드 리소스 0·script 0). */
export function toProofHtml(r: Receipt, anchor?: RekorAnchor | null, extras?: ProofExtras): string {
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

  // Stage 1b: Rekor 앵커가 있으면 *클릭형* 제3자 검증 섹션. 앵커 없으면 ""(섹션 자체 없음).
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

  // 완전성 보증 iter1b(6차 council #3·#6): git 이 바꿨으나 capture 기록 없는 경로(훅 사각) + 커버리지 caveat.
  const gitChanged = new Set<string>([...r.touched, ...r.staged, ...r.untracked]);
  const capturedPaths = new Set<string>((r.actions ?? []).map((a) => a.path).filter((p): p is string => !!p));
  const uncovered = r.actions !== undefined ? [...gitChanged].filter((p) => !capturedPaths.has(p)) : [];
  const uncoveredRows = uncovered.slice(0, 10).map((p) => `<li><code>${esc(p)}</code></li>`).join("\n");
  const moreLi = uncovered.length > 10 ? `\n  <li class="muted">+ ${uncovered.length - 10} more</li>` : "";
  const coverageSection = uncovered.length
    ? `
  <section>
  <h2>Capture coverage</h2>
  <p class="contrast">⚠ <strong>${uncovered.length}</strong> git-changed path(s) have <strong>no capture record</strong> — outside the captured hook surface, or the hook was inactive.</p>
  <ul class="actions">${uncoveredRows}${moreLi}</ul>
  <p class="meta">Captured surface: ${esc(COVERED_TOOLS.join(", "))}. Not captured: WebFetch / MCP / sub-agent / OS-level. This proof is <strong>tamper-evident &amp; gap-evident — not complete</strong>.</p>
</section>`
    : "";

  // ── P2 D5: Evidence 탭 — vreceipts 요약(있으면) / 정직한 빈 상태(없으면 어떻게 포함하나) ──
  const ev = extras?.evidence ?? null;
  const evidencePane = ev
    ? `<section>
  <h2>Verification receipts${extras?.evidenceDirLabel ? ` — <code>${esc(extras.evidenceDirLabel)}</code>` : ""}</h2>
  <p class="contrast"><strong>${ev.receipts}</strong> receipt(s) — pass <strong>${ev.pass}</strong> · fail <strong>${ev.fail}</strong>${ev.exceptions ? ` · <strong>exceptions ${ev.exceptions}</strong> (seal-replay fail / ungrounded decision / unreachable source)` : ""}</p>
  ${ev.mostFailedCheck ? `<p class="meta">Most-failed check: <code>${esc(ev.mostFailedCheck)}</code></p>` : ""}
  <p class="meta">Each receipt re-verifies locally: <code>agent-receipt replay --receipt &lt;file&gt;</code> (seal recompute · input drift · commit link). Counts are a neutral rollup — <strong>not a judgment</strong>.</p>
</section>`
    : `<section>
  <h2>Verification receipts</h2>
  <p class="meta">Not included — generate with <code>agent-receipt share-proof --evidence-dir .agent-guard/vreceipts</code> to embed a neutral pass/fail rollup of this session's evidence checks.</p>
</section>`;

  // ── v0.20 결정1·2 + 배치A-1: 10초 요약 블록(탭 위 고정) — 전 수치가 Receipt 필드 그대로(신규 계산 0·"권장" 어휘 금지) ──
  // 배치A-1(council 2026-07-07): 신호를 4버킷(리뷰어의 실제 판단 순서)으로 재그룹 — *재배치만*(재그룹 전후 신호 집합 동일을 테스트가 단언).
  //   민감 렉시콘 내장 금지 — Critical 버킷의 판단 주체는 계약/policy(도구는 매칭만·버킷명에 명시).
  const prose = r.contractSnapshot ? renderContractProse(r.contractSnapshot) : null;
  const guardDenied = r.actions ? r.actions.filter((a) => a.denied).length : null;
  const checksPassed = r.checks.filter((c) => c.ok).length;
  const signals = r.verdict?.reasons ?? [];
  const BUCKET_TITLES = [
    "1 · Scope — 계약 범위",
    "2 · Critical paths — 계약이 지정한 고위험",
    "3 · Validation — 검사·측정 기반",
    "4 · Agent behavior — 행위 신호",
  ] as const;
  const BUCKET_OF: Record<string, 0 | 1 | 2 | 3> = {
    "denied-path": 0, "out-of-scope": 0,
    "critical-path": 1, "policy-forbid": 1,
    "check-failed": 2, "verify-fail": 2, "no-baseline": 2, "stale-branch-mismatch": 2, "stale-baseline-not-ancestor": 2, "stale-unknown": 2,
    "waste-signal": 3, "red-flag": 3,
  };
  const BUCKET_CAP = 5;
  const bucketed: string[][] = [[], [], [], []];
  const unbucketed: string[] = []; // rule-id 없는 reason(PASS 문장 등) — 버킷 밖 그대로(누락 금지)
  for (const s2 of signals) {
    const m = s2.match(/^\[([a-z-]+)\]/);
    if (m && BUCKET_OF[m[1]] !== undefined) bucketed[BUCKET_OF[m[1]]].push(s2);
    else unbucketed.push(s2);
  }
  const bucketHtml = BUCKET_TITLES.map((title, i) => {
    const items = bucketed[i];
    const shown = items.slice(0, BUCKET_CAP);
    const foldedN = items.length - shown.length;
    return `<p class="meta"><strong>${esc(title)}</strong>${items.length === 0 ? " — 해당 없음" : ""}</p>${
      shown.length ? `\n  <ul class="actions">${shown.map((x) => `<li>${esc(x)}</li>`).join("\n")}${foldedN > 0 ? `\n  <li class="muted">외 ${foldedN}건 — 접힘을 여기(인쇄 포함) 명시</li>` : ""}</ul>` : ""
    }`;
  }).join("\n  ");
  const execSummary = `
  <section class="exec">
  ${prose ? `<p class="meta"><b>${esc(prose.ko)}</b></p>\n  <p class="meta">${esc(prose.en)}</p>` : ""}
  ${r.session?.objective ? `<p class="meta">Session objective (self-reported, unverified · 자가보고): ${esc(r.session.objective)}</p>` : ""}
  ${extras?.review ? `<p class="meta"><strong>Review recorded: ${esc(extras.review.status)}</strong> by ${esc(extras.review.reviewer)} at ${esc(extras.review.reviewedAt)} (self-reported — a record, not an authority)${extras.review.note ? ` — ${esc(extras.review.note)}` : ""}</p>` : ""}
  <p class="meta">Changed: <strong>${r.touched.length}</strong> file(s) (+${r.magnitude.added} / -${r.magnitude.deleted} lines, ${r.magnitude.newFiles} new) · Critical paths: ${critTxt} · Checks: ${r.checks.length ? `${checksPassed}/${r.checks.length} OK` : "none"}${guardDenied !== null ? ` · Guard-denied events: <strong>${guardDenied}</strong>` : ""}</p>
  <p class="meta">Review focus — 판정 사실의 재배치(a pointer, <strong>not a judgment</strong> and not the whole):</p>
  ${bucketHtml}
  ${unbucketed.length ? `<ul class="actions">${unbucketed.map((x) => `<li>${esc(x)}</li>`).join("\n")}</ul>` : ""}
  </section>`;

  // ── v0.20 결정3: 세션 타임라인 — capture(행위) / git(커밋 시각 축약판·정직 라벨) ──
  const tl = extras?.timeline ?? null;
  const timelineSection = tl
    ? `
  <section>
  <h2>Session timeline${tl.source === "capture" ? " (captured actions)" : " (git commit times)"}</h2>
  ${tl.source === "git" ? `<p class="meta">Behavior-level timeline appears when capture hooks are installed — showing commit times only.</p>` : ""}
  <ul class="actions">${tl.events.map((e) => `<li><code>${esc(e.ts)}</code> ${esc(e.label)}</li>`).join("\n")}</ul>
  ${tl.folded ? `<p class="meta">+ ${tl.folded} earlier event(s) folded — the fold is stated here (and in print), not hidden.</p>` : ""}
  </section>`
    : "";

  // ── P2 D5: Cost 탭 — 생성 시점 세션 추정(있으면) / 정직한 빈 상태 ──
  const cl = extras?.costLines ?? null;
  const costPane = cl && cl.length
    ? `<section>
  <h2>Session cost (at proof-generation time)</h2>
  ${cl.map((x) => `<p class="meta">${esc(x)}</p>`).join("\n  ")}
  <p class="meta"><strong>Estimate, not an invoice</strong> — local transcript × list price, read at generation time; it is not stored in the sealed receipt.</p>
</section>`
    : `<section>
  <h2>Session cost</h2>
  <p class="meta">Not included — generate with <code>agent-receipt share-proof --with-cost</code> to embed the session's estimated token cost (local transcript · estimate, not an invoice).</p>
</section>`;

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
  /* P2 D5 — CSS-only tabs (radio hack · script 0). CSS 미지원 폴백 = 전 패널 보임. */
  .tabs>input.tabradio{position:absolute;opacity:0;pointer-events:none}
  .tablabels{display:flex;gap:.35rem;border-bottom:2px solid #e3e3e6;margin:1.2rem 0 .9rem}
  .tablabels label{padding:.35rem .8rem;border:1px solid #e3e3e6;border-bottom:none;border-radius:8px 8px 0 0;cursor:pointer;font-size:.88rem;color:#666;background:#fafafa}
  .tabs .pane{display:none}
  #pt-change:checked~.pane-change{display:block}
  #pt-evidence:checked~.pane-evidence{display:block}
  #pt-cost:checked~.pane-cost{display:block}
  #pt-change:checked~.tablabels label[for="pt-change"],#pt-evidence:checked~.tablabels label[for="pt-evidence"],#pt-cost:checked~.tablabels label[for="pt-cost"]{background:#fff;color:#1a1a1a;font-weight:600;border-bottom:2px solid #fff;margin-bottom:-2px}
  @media print{.tabs .pane{display:block!important}.tablabels,.tabs>input.tabradio{display:none!important}} /* DA-3: 인쇄=전 패널 펼침(증거 숨김 금지) */
</style></head><body>
<div class="wrap">
  <h1>AI Work Receipt</h1>
  <p class="meta">Scope evidence for <code>${esc(r.contractId)}</code>${r.title ? ` — ${esc(r.title)}` : ""}</p>${r.verdict ? `\n  <p class="meta"><b>${esc(renderVerdictLine(r.verdict))}</b></p>` : ""}${r.contractSnapshot ? `\n  <p class="meta">${esc(renderContractLine(r.contractSnapshot))}</p>` : ""}
  <div class="status">${statusTxt}</div>${execSummary}
  <div class="tabs">
  <input class="tabradio" type="radio" name="proof-tab" id="pt-change" checked>
  <input class="tabradio" type="radio" name="proof-tab" id="pt-evidence">
  <input class="tabradio" type="radio" name="proof-tab" id="pt-cost">
  <div class="tablabels"><label for="pt-change">Change</label><label for="pt-evidence">Evidence</label><label for="pt-cost">Cost</label></div>
  <div class="pane pane-change">
  ${extras?.client
    ? `<p class="meta"><strong>Condensed client view</strong> — a condensed <strong>view of the same sealed evidence</strong>, not a separate document (배치A-3: 같은 증빙의 축약 뷰).</p>
  <table>
    <tr><td class="k">Same evidence (contentHash)</td><td class="hash">${esc(r.contentHash)}</td></tr>
    <tr><td class="k">Contract</td><td><code>${esc(r.contractId)}</code></td></tr>
    <tr><td class="k">Generated</td><td>${esc(r.timestamp)}</td></tr>
    <tr><td class="k">Full technical proof</td><td>generate with <code>agent-receipt share</code> on the same receipt — identical contentHash</td></tr>
    <tr><td class="k">Preservation bundle</td><td><code>agent-receipt share --bundle</code> → recipient verifies offline with <code>verify-proof</code></td></tr>
  </table>
  <p class="meta">Omitted in this view (all present in the full proof/bundle of the same contentHash): full touched-file list · detailed technical table · beyond-git action detail · capture coverage detail.</p>
  ${anchorSection}${timelineSection}`
    : `<table>
    <tr><td class="k">Result</td><td>${pass ? "Stayed within agreed scope" : "Out-of-scope / contract violation — see details"}</td></tr>
    <tr><td class="k">Branch</td><td><code>${esc(r.branch.current)}</code>${r.branch.expected ? ` (expected <code>${esc(r.branch.expected)}</code>)` : ""}</td></tr>
    <tr><td class="k">Commit (HEAD)</td><td><code>${esc(r.headHash)}</code></td></tr>
    <tr><td class="k">Files changed</td><td>${r.touched.length} (${r.magnitude.filesChanged} files, +${r.magnitude.added} / -${r.magnitude.deleted} lines, ${r.magnitude.newFiles} new)</td></tr>
    <tr><td class="k">Critical paths</td><td>${critTxt}</td></tr>
    <tr><td class="k">Checks</td><td>${r.checks.length ? r.checks.map((c) => `${esc(c.name)} ${c.ok ? "OK" : "✗"}`).join(", ") : "none"}</td></tr>
    <tr><td class="k">Integrity (contentHash)</td><td class="hash">${esc(r.contentHash)}</td></tr>
    <tr><td class="k">Generated</td><td>${esc(r.timestamp)}</td></tr>
  </table>
  ${beyondGit}${coverageSection}${anchorSection}${timelineSection}`}
  </div>
  <div class="pane pane-evidence">
  ${evidencePane}
  </div>
  <div class="pane pane-cost">
  ${costPane}
  </div>
  </div>
  <footer>
    ${esc(LIMIT_NOTE)}<br>
    git-based evidence — <strong>tamper-evident, not non-forgeable</strong>. This is evidence for review, <strong>not a compliance guarantee</strong>. Generated locally; no data left the machine.
  </footer>
</div>
</body></html>
`;
}

// ── CLI 옵션(P2) ──
export interface ShareProofOpts {
  out?: string;
  redact?: boolean;
  evidenceDir?: string;
  withCost?: boolean;
  bundle?: boolean;
  client?: boolean; // v0.20 결정5 — 축약판
}

// extras 조립 — opt-in 플래그일 때만 IO(기본 경로 IO 불변).
function buildExtras(opts: ShareProofOpts, cwd: string): ProofExtras {
  const evDir = opts.evidenceDir ? (isAbsolute(opts.evidenceDir) ? opts.evidenceDir : join(cwd, opts.evidenceDir)) : null;
  const evidence = evDir ? buildProofEvidence(evDir) : null;
  let cost: string[] | null = null;
  if (opts.withCost) {
    try {
      const sum = summarizeCurrentSession(cwd);
      cost = sum.supported ? costLines(sum) : null;
    } catch {
      cost = null; // 비용 읽기 실패 = 미포함(가짜 숫자 금지)
    }
  }
  return { evidence, evidenceDirLabel: opts.evidenceDir ?? null, costLines: cost, timeline: buildProofTimeline(cwd), ...(opts.client ? { client: true } : {}) };
}

/**
 * `agent-receipt share-proof [--out <path>] [--redact] [--evidence-dir <d>] [--with-cost]` — receipt 를
 * 클라이언트 전달용 self-contained 3축 탭 HTML 로 저장. exit = ok ? 0 : 1.
 */
function writeProof(r: Receipt, opts: ShareProofOpts, anchor: RekorAnchor | null, cwd: string, review: ReviewRecord | null = null): never {
  let html = toProofHtml(r, anchor, { ...buildExtras(opts, cwd), review });
  if (opts.redact) html = redactText(html).text;
  const stamp = (r.timestamp ?? "receipt").replace(/[:.]/g, "-");
  const rel = opts.out ?? join(".agent-guard", `proof-${stamp}.html`);
  const out = isAbsolute(rel) ? rel : join(cwd, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`share-proof 생성: ${rel} (${r.ok ? "PASS" : "FAIL"})`);
  console.log("  → 브라우저로 열어 확인 후 클라이언트에게 이 파일을 보내세요(로컬 증거·외부 전송 0).");
  console.log(`  ${LIMIT_NOTE}`);
  process.exit(r.ok ? 0 : 1);
}

// ── P2 D6: proof bundle — 공유용 디렉터리(html + receipt.json + anchor sidecar + public key + VERIFY.md) ──
// audit-pack 과 목적 분리(감사용 claim 대조 vs 제3자 공유·검증 안내) — Simplicity dissent 기록됨.
export function buildVerifyMd(hasDsse: boolean, hasRekor: boolean, rekorUrl: string | null, hasPublicKey: boolean, evidenceFiles: number): string {
  const L: string[] = [];
  L.push("# How to verify this proof bundle / 이 증거 묶음을 검증하는 법");
  L.push("");
  L.push("## Contents / 구성");
  L.push("- `index.html` — the human-readable proof page (self-contained; opening it loads nothing external).");
  L.push("- `receipt.json` — the sealed work receipt (fields + `contentHash`).");
  if (hasDsse) L.push("- `anchor.dsse.json` — DSSE envelope (in-toto Statement, ed25519-signed).");
  if (hasRekor) L.push("- `anchor.rekor.json` — third-party transparency-log registration (Rekor).");
  if (hasPublicKey) L.push("- `public.pem` — the signer's self-managed ed25519 public key.");
  if (evidenceFiles > 0) L.push(`- \`evidence/\` — ${evidenceFiles} verification receipt(s) (research/council/bench).`);
  L.push("");
  L.push("## Verify / 검증");
  if (hasRekor && rekorUrl) {
    L.push(`1. **Third-party (no trust in the sender needed)**: open ${rekorUrl} — the public Rekor log confirms this receipt **existed at that time**. Seals time & existence — not the signer's real-world identity.`);
  } else {
    L.push("1. **Third-party anchor: not present** — this bundle has no Rekor registration (the sender can add one with `agent-receipt anchor --upload`).");
  }
  if (hasDsse && hasPublicKey) {
    L.push("2. **Signature**: `anchor.dsse.json` is a standard DSSE envelope over an in-toto Statement whose `subject.digest` is the receipt's `contentHash`. Verify with any DSSE verifier against `public.pem` (self-managed key: proves integrity + signer-key possession, **not identity**).");
  }
  if (evidenceFiles > 0) {
    L.push("3. **Evidence receipts**: each file in `evidence/` re-verifies locally — `npx @promptia-labs/agent-receipt replay --receipt evidence/<file>` (seal recompute · input drift · commit link).");
  }
  L.push("");
  L.push("## Honest limits / 정직한 경계");
  L.push("- git-based evidence — **tamper-evident, not non-forgeable**; evidence for review, **not a compliance guarantee**.");
  L.push("- Re-measuring the work itself requires the original repository — outside this bundle's scope.");
  L.push("");
  return L.join("\n");
}
export function runProofBundle(receiptPath: string | undefined, opts: ShareProofOpts, cwd: string = process.cwd()): never {
  const { abs, receipt: r } = loadSavedReceipt(receiptPath, "share-proof --bundle", cwd); // 저장 receipt 필수(사이드카 정체성)
  const anchor = loadRekorAnchor(abs);
  let html = toProofHtml(r, anchor, { ...buildExtras(opts, cwd), review: reviewStatusFor(abs) });
  let receiptJson = readFileSync(abs, "utf8");
  if (opts.redact) {
    html = redactText(html).text;
    receiptJson = redactJsonText(receiptJson).text; // audit-pack 과 동일 규칙(JSON 구조 인식)
  }
  const stamp = (r.timestamp ?? "receipt").replace(/[:.]/g, "-");
  const rel = opts.out ?? join(".agent-guard", `proof-bundle-${stamp}`);
  const dir = isAbsolute(rel) ? rel : join(cwd, rel);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const put = (name: string, body: string): void => {
    writeFileSync(join(dir, name), body);
    files.push(name);
  };
  put("index.html", html);
  put("receipt.json", receiptJson);
  const base = basename(abs).replace(/\.json$/, "");
  const dssePath = join(cwd, ".agent-guard", "anchors", `${base}.dsse.json`);
  if (existsSync(dssePath)) put("anchor.dsse.json", readFileSync(dssePath, "utf8"));
  const rekorPath = rekorAnchorPath(abs);
  if (existsSync(rekorPath)) put("anchor.rekor.json", readFileSync(rekorPath, "utf8"));
  const pubPath = join(cwd, publicKeyRelPath());
  if (existsSync(pubPath)) put("public.pem", readFileSync(pubPath, "utf8"));
  let evidenceFiles = 0;
  if (opts.evidenceDir) {
    const evDir = isAbsolute(opts.evidenceDir) ? opts.evidenceDir : join(cwd, opts.evidenceDir);
    if (existsSync(evDir)) {
      const names = readdirSync(evDir).filter((n) => n.endsWith(".json"));
      if (names.length) {
        mkdirSync(join(dir, "evidence"), { recursive: true });
        for (const nm of names) {
          const body = readFileSync(join(evDir, nm), "utf8");
          writeFileSync(join(dir, "evidence", nm), opts.redact ? redactJsonText(body).text : body);
          files.push(`evidence/${nm}`);
          evidenceFiles++;
        }
      }
    }
  }
  put("VERIFY.md", buildVerifyMd(existsSync(dssePath), existsSync(rekorPath), anchor?.verifyUrl ?? null, existsSync(pubPath), evidenceFiles));
  console.log(`proof bundle 생성: ${rel} (${r.ok ? "PASS" : "FAIL"} · 파일 ${files.length}개)`);
  for (const f of files) console.log(`  - ${f}`);
  console.log("  → 폴더째 전달하세요. 받는 쪽 검증 절차는 VERIFY.md 에(제3자 Rekor 링크·DSSE 서명·evidence replay).");
  console.log(`  ${LIMIT_NOTE}`);
  process.exit(r.ok ? 0 : 1);
}

/** 현재 상태로 receipt 를 새로 만들어 렌더(계약 필요). 저장 receipt 가 없을 때의 fallback. */
export function runShareProof(contract: Contract, contractPath: string | undefined, opts: ShareProofOpts): never {
  if (opts.bundle) {
    console.error("share-proof --bundle: 저장된 receipt 가 필요합니다 — 먼저 `agent-receipt done` 을 실행하세요(사이드카·봉인 정체성).");
    process.exit(2);
  }
  writeProof(buildReceipt(contract, contractPath), opts, null, process.cwd());
}

/** 저장된 receipt(.json)가 하나라도 있나 — cli 가 "기본=최신 렌더 vs fresh build" 분기에 사용. */
export function latestReceiptExists(cwd: string = process.cwd()): boolean {
  return listReceipts(cwd).some((e) => e.name.endsWith(".json"));
}

/**
 * `agent-receipt share-proof [--receipt <path>] [--bundle]` — 저장된 receipt 를 렌더(기본 최신).
 * done/receipt 시점 그대로 클라이언트에 증명. 파싱/형식 실패 = exit 2(계약 불필요).
 */
export function runShareProofFromSaved(receiptPath: string | undefined, opts: ShareProofOpts, cwd: string = process.cwd()): never {
  if (opts.bundle) runProofBundle(receiptPath, opts, cwd);
  const { abs, receipt: r } = loadSavedReceipt(receiptPath, "share-proof", cwd); // 13차 council: 공용 로더
  writeProof(r, opts, loadRekorAnchor(abs), cwd, reviewStatusFor(abs)); // 배치A-2: 검토 기록 표면화
}
