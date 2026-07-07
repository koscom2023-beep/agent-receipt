#!/usr/bin/env node
// PR 영수증 코멘트 본문 생성기 — 봉인된 Verification Receipt(JSON)의 *기계적 투영*만 출력한다.
// council 2026-07-03 결정 4: 영수증에 없는 문장(자유 텍스트·마케팅·절감 주장) 생성 금지 — 어긋나면 영수증이 정본.
// 첫 줄 MARKER 는 upsert 식별자 — action.yml 이 이 줄로 기존 코멘트를 찾아 갱신한다(도배 방지).
import { readFileSync } from "node:fs";

export const MARKER = "<!-- agent-receipt-verify -->";

// v0.21 결정9 — PR 변경파일 ⟷ Work Receipt touched 대칭차(기계·판단 0). 둘 다 정렬(결정론).
export function fileMismatch(prFiles, receiptTouched) {
  const prSet = new Set(prFiles);
  const rSet = new Set(receiptTouched);
  return {
    prOnly: [...prFiles].filter((f) => !rSet.has(f)).sort(),
    receiptOnly: [...receiptTouched].filter((f) => !prSet.has(f)).sort(),
  };
}

const FAIL_STATUS = /fail|mismatch|not-found|invalid|unreachable/;

export function buildBody(r, opts = {}) {
  const lines = [];
  lines.push(MARKER);
  const icon = r.verdict === "pass" ? "✅" : "❌";
  lines.push(`### ${icon} agent-receipt verify — ${String(r.verdict ?? "?")}`);
  if (opts.review) {
    // 배치B-8 — 검토 배지: 사이드카의 기계 투영(자가보고 — 권위 아님·판단 없음).
    const rb = opts.review.status === "rejected" ? "✗" : opts.review.status === "needs-review" ? "◌" : "✓";
    lines.push(`**review**: ${rb} ${String(opts.review.status)} by ${String(opts.review.reviewer ?? "?")} _(self-reported record, not an authority)_`);
  }
  if (opts.proofUrl) lines.push(`**proof**: ${String(opts.proofUrl)}`); // v0.21 결정9 — 링크 슬롯(값은 호출자 제공·발명 0)
  if (typeof r.subject === "string" && r.subject) lines.push(`\`${r.subject.slice(0, 120)}\``);
  lines.push("");
  const sum = r.summary && typeof r.summary === "object" ? r.summary : {};
  const sumStr = Object.entries(sum)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (sumStr) lines.push(`**claims**: ${sumStr}`);
  const failed = Array.isArray(r.results) ? r.results.filter((x) => x && x.verdict === "failed") : [];
  if (failed.length) {
    lines.push("");
    lines.push(`**failed claims** (${failed.length}):`);
    for (const f of failed.slice(0, 5)) {
      const kinds =
        f.checks && typeof f.checks === "object"
          ? Object.entries(f.checks)
              .filter(([, v]) => typeof v === "string" && FAIL_STATUS.test(v))
              .map(([k, v]) => `${k}: ${v}`)
          : [];
      lines.push(`- ${String(f.statement ?? "(statement 없음)").slice(0, 200)}${kinds.length ? ` — ${kinds.join(", ")}` : ""}`);
    }
    if (failed.length > 5) lines.push(`- … ${failed.length - 5} more`);
  }
  if (opts.mismatch) {
    const m = opts.mismatch;
    lines.push("");
    lines.push("**PR files ⟷ work receipt.touched** (symmetric diff — mechanical, not a judgment):");
    if (!m.prOnly.length && !m.receiptOnly.length) lines.push("- match ✅ (no difference)");
    for (const f of m.prOnly.slice(0, 10)) lines.push(`- in PR only: \`${f}\``);
    if (m.prOnly.length > 10) lines.push(`- … ${m.prOnly.length - 10} more (PR only)`);
    for (const f of m.receiptOnly.slice(0, 10)) lines.push(`- in receipt only: \`${f}\``);
    if (m.receiptOnly.length > 10) lines.push(`- … ${m.receiptOnly.length - 10} more (receipt only)`);
  }
  if (opts.workReceiptMissing) {
    lines.push("");
    lines.push("⚠ **no work receipt attached** — this PR ran without a session receipt (opt-in check; absence is stated, not judged).");
  }
  lines.push("");
  lines.push(
    `<sub>receiptId \`${String(r.receiptId ?? "").slice(0, 12)}\` · input sha256 \`${String(r.input?.sha256 ?? "").slice(0, 12)}\` · verifier ${String(r.tool?.version ?? "?")} — the sealed receipt is the source of truth; this comment is a mechanical projection of it.</sub>`,
  );
  return lines.join("\n");
}

// 배치B-8 — 1줄 요약(stdout 전용·코멘트 POST 와 분리·CI 로그/타 채널 재사용). 기계 투영만.
export function buildSummaryLine(r, opts = {}) {
  const icon = r.verdict === "pass" ? "✅" : "❌";
  const sum = r.summary && typeof r.summary === "object" ? r.summary : {};
  const sumStr = Object.entries(sum).map(([k, v]) => `${k} ${v}`).join(" · ");
  const rev = opts.review ? ` · review: ${String(opts.review.status)}(self-reported)` : "";
  const proof = opts.proofUrl ? ` · proof: ${String(opts.proofUrl)}` : "";
  return `${icon} agent-receipt verify — ${String(r.verdict ?? "?")}${sumStr ? ` · ${sumStr}` : ""}${rev}${proof} · receiptId ${String(r.receiptId ?? "").slice(0, 12)}`;
}

// CLI: node pr-comment-body.mjs <verification-receipt.json> [--proof-url U] [--work-receipt P] [--pr-files listfile] [--warn-no-receipt]
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2];
  if (!p) {
    console.error("usage: pr-comment-body.mjs <verification-receipt.json> [--proof-url U] [--work-receipt P] [--pr-files listfile] [--warn-no-receipt]");
    process.exit(2);
  }
  const arg = (f) => {
    const i = process.argv.indexOf(f);
    return i > 2 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const r = JSON.parse(readFileSync(p, "utf8"));
  const opts = {};
  const proofUrl = arg("--proof-url");
  if (proofUrl) opts.proofUrl = proofUrl;
  const wr = arg("--work-receipt");
  if (wr) {
    try {
      const sc = JSON.parse(readFileSync(wr + ".approval.json", "utf8"));
      const status = sc.status === "rejected" || sc.status === "needs-review" ? sc.status : "approved"; // 구파일=approved(하위호환)
      opts.review = { status, reviewer: sc.reviewer ?? sc.approver ?? "unknown" };
    } catch {
      /* 사이드카 없음 = 배지 없음(발명 0) */
    }
  }
  const prFilesPath = arg("--pr-files");
  if (wr && prFilesPath) {
    try {
      const receipt = JSON.parse(readFileSync(wr, "utf8"));
      const prFiles = readFileSync(prFilesPath, "utf8").split("\n").filter(Boolean);
      opts.mismatch = fileMismatch(prFiles, Array.isArray(receipt.touched) ? receipt.touched : []);
    } catch {
      if (process.argv.includes("--warn-no-receipt")) opts.workReceiptMissing = true; // 못 읽음 = 없음으로 자백(opt-in)
    }
  } else if (process.argv.includes("--warn-no-receipt") && wr) {
    opts.workReceiptMissing = true;
  }
  if (process.argv.includes("--summary")) {
    process.stdout.write(buildSummaryLine(r, opts) + "\n"); // 배치B-8 — 1줄 모드(코멘트와 분리)
  } else {
    process.stdout.write(buildBody(r, opts) + "\n");
  }
}
