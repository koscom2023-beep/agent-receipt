#!/usr/bin/env node
// PR 영수증 코멘트 본문 생성기 — 봉인된 Verification Receipt(JSON)의 *기계적 투영*만 출력한다.
// council 2026-07-03 결정 4: 영수증에 없는 문장(자유 텍스트·마케팅·절감 주장) 생성 금지 — 어긋나면 영수증이 정본.
// 첫 줄 MARKER 는 upsert 식별자 — action.yml 이 이 줄로 기존 코멘트를 찾아 갱신한다(도배 방지).
import { readFileSync } from "node:fs";

export const MARKER = "<!-- agent-receipt-verify -->";

const FAIL_STATUS = /fail|mismatch|not-found|invalid|unreachable/;

export function buildBody(r) {
  const lines = [];
  lines.push(MARKER);
  const icon = r.verdict === "pass" ? "✅" : "❌";
  lines.push(`### ${icon} agent-receipt verify — ${String(r.verdict ?? "?")}`);
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
  lines.push("");
  lines.push(
    `<sub>receiptId \`${String(r.receiptId ?? "").slice(0, 12)}\` · input sha256 \`${String(r.input?.sha256 ?? "").slice(0, 12)}\` · verifier ${String(r.tool?.version ?? "?")} — the sealed receipt is the source of truth; this comment is a mechanical projection of it.</sub>`,
  );
  return lines.join("\n");
}

// CLI: node pr-comment-body.mjs <verification-receipt.json>
if (import.meta.url === `file://${process.argv[1]}`) {
  const p = process.argv[2];
  if (!p) {
    console.error("usage: pr-comment-body.mjs <verification-receipt.json>");
    process.exit(2);
  }
  const r = JSON.parse(readFileSync(p, "utf8"));
  process.stdout.write(buildBody(r) + "\n");
}
