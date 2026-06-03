import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseReceiptJson, criticalTouchedCount } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";

const FORMATS = ["slack", "json", "github-pr", "otel", "langfuse"] as const;
type Fmt = (typeof FORMATS)[number];

/**
 * `agent-receipt export --format <slack|json|github-pr|otel|langfuse> --receipt <path>`
 * 외부 전송용 payload "미리보기"를 stdout 에만 출력. 실제 POST·토큰·URL 입력 없음(local-first, dry-run only).
 * 정체성: 이건 payload preview 이며 실제 연동이 아니다. exit 0/2.
 */
export function runExport(format: string | undefined, receiptArg: string | undefined, cwd: string = process.cwd()): never {
  const fmt = (FORMATS as readonly string[]).includes(format ?? "") ? (format as Fmt) : null;
  if (!fmt) {
    console.error(`export: --format <${FORMATS.join("|")}> 가 필요합니다.`);
    process.exit(2);
  }
  if (!receiptArg) {
    console.error("export: --receipt <path> 가 필요합니다.");
    process.exit(2);
  }
  const rpath = isAbsolute(receiptArg) ? receiptArg : join(cwd, receiptArg);
  if (!existsSync(rpath)) {
    console.error(`export: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const o = parseReceiptJson(rpath);
  if (!o) {
    console.error("export: json receipt 가 필요합니다 (md 는 미지원).");
    process.exit(2);
  }

  const status = o.ok === true ? "PASS ✅" : o.ok === false ? "FAIL ❌" : "?";
  const files = Array.isArray(o.touched) ? o.touched.length : 0;
  const critical = criticalTouchedCount(o);
  const mag = o.magnitude
    ? `${o.magnitude.filesChanged ?? 0} files, +${o.magnitude.added ?? 0}/-${o.magnitude.deleted ?? 0}, ${o.magnitude.newFiles ?? 0} new`
    : "-";

  const previewNote = "note: payload 미리보기만 출력했습니다 — 실제 전송/POST/등록은 하지 않습니다(토큰/URL 없음).\n";

  if (fmt === "json") {
    const payload = {
      kind: "agent-receipt.export",
      contractId: o.contractId ?? null,
      ok: o.ok ?? null,
      headHash: o.headHash ?? null,
      timestamp: o.timestamp ?? null,
      contentHash: o.contentHash ?? null,
      filesChanged: files,
      magnitude: o.magnitude ?? null,
      criticalTouched: critical,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(0);
  }

  if (fmt === "slack") {
    const payload = {
      text: `AI Work Receipt — ${o.contractId ?? "?"}: ${status}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*AI Work Receipt — ${o.contractId ?? "?"}*  ${status}` } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `HEAD: \`${o.headHash ?? "?"}\`\nfiles changed: ${files}\nmagnitude: ${mag}\ncritical touched: ${critical}\ncontentHash: \`${o.contentHash ?? "?"}\``,
          },
        },
      ],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.stderr.write("note: 미리보기만 출력했습니다 — 실제 Slack 전송/webhook POST 는 하지 않습니다(토큰/URL 없음).\n");
    process.exit(0);
  }

  if (fmt === "github-pr") {
    // PR 댓글 본문(markdown) 미리보기. 자동 댓글 게시는 하지 않음(수요 신호 후).
    const L = [
      `## 🧾 AI Work Receipt — \`${o.contractId ?? "?"}\`: ${status}`,
      "",
      `- HEAD: \`${o.headHash ?? "?"}\``,
      `- files changed: ${files}`,
      `- magnitude: ${mag}`,
      `- critical touched: ${critical}`,
      `- contentHash: \`${o.contentHash ?? "?"}\``,
      "",
      `> ${LIMIT_NOTE}`,
      `> _payload preview — 실제 PR 댓글 게시 안 함_`,
      "",
    ];
    process.stdout.write(L.join("\n"));
    process.stderr.write(previewNote);
    process.exit(0);
  }

  if (fmt === "otel") {
    // OpenTelemetry(OTLP) log record 모양 미리보기(전송 안 함).
    const attr = (k: string, v: string | number | boolean) => ({
      key: k,
      value: typeof v === "number" ? { intValue: v } : typeof v === "boolean" ? { boolValue: v } : { stringValue: v },
    });
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [attr("service.name", "agent-receipt")] },
          scopeLogs: [
            {
              scope: { name: "agent-receipt.export" },
              logRecords: [
                {
                  body: { stringValue: `AI Work Receipt ${o.contractId ?? "?"} ${status}` },
                  attributes: [
                    attr("agent_receipt.contract_id", o.contractId ?? "?"),
                    attr("agent_receipt.ok", o.ok === true),
                    attr("agent_receipt.head_hash", o.headHash ?? "?"),
                    attr("agent_receipt.content_hash", o.contentHash ?? "?"),
                    attr("agent_receipt.files_changed", files),
                    attr("agent_receipt.critical_touched", critical),
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.stderr.write(previewNote);
    process.exit(0);
  }

  // langfuse: trace event 모양 미리보기(전송 안 함).
  const payload = {
    type: "trace-create",
    body: {
      name: "agent-receipt",
      metadata: {
        contractId: o.contractId ?? null,
        ok: o.ok ?? null,
        headHash: o.headHash ?? null,
        contentHash: o.contentHash ?? null,
        filesChanged: files,
        criticalTouched: critical,
      },
    },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.stderr.write(previewNote);
  process.exit(0);
}
