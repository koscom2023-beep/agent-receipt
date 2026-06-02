import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parseReceiptJson, criticalTouchedCount } from "./receiptStore.js";

/**
 * `agent-receipt export --format <slack|json> --receipt <path>` — 외부 전송용 payload "미리보기"를 stdout 에만 출력.
 * 실제 Slack/webhook POST·토큰·URL 입력은 하지 않는다(local-first, dry-run only). exit 0/2.
 */
export function runExport(format: string | undefined, receiptArg: string | undefined, cwd: string = process.cwd()): never {
  const fmt = format === "slack" ? "slack" : format === "json" ? "json" : null;
  if (!fmt) {
    console.error("export: --format <slack|json> 가 필요합니다.");
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
  const mag = o.magnitude
    ? `${o.magnitude.filesChanged ?? 0} files, +${o.magnitude.added ?? 0}/-${o.magnitude.deleted ?? 0}, ${o.magnitude.newFiles ?? 0} new`
    : "-";

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
      criticalTouched: criticalTouchedCount(o),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    process.exit(0);
  }

  // slack: webhook 으로 보낼 수 있는 payload 모양만 출력(전송 안 함).
  const payload = {
    text: `AI Work Receipt — ${o.contractId ?? "?"}: ${status}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*AI Work Receipt — ${o.contractId ?? "?"}*  ${status}` } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `HEAD: \`${o.headHash ?? "?"}\`\nfiles changed: ${files}\nmagnitude: ${mag}\ncritical touched: ${criticalTouchedCount(o)}\ncontentHash: \`${o.contentHash ?? "?"}\``,
        },
      },
    ],
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  process.stderr.write("note: 미리보기만 출력했습니다 — 실제 Slack 전송/webhook POST 는 하지 않습니다(토큰/URL 없음).\n");
  process.exit(0);
}
