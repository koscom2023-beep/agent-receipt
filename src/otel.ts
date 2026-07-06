import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";

// R8: 검증 이벤트를 OpenTelemetry(OTLP) 형태로 방출 — 사용자의 기존 관측 파이프라인(collector/GenAI 대시보드)에 편입.
//
// 정직(회의): deps-0 유지 — @opentelemetry SDK 를 번들하지 않고 **OTLP JSON 구조만** 생산한다(exporter=BYO).
//   이건 결정론 *검증* 이벤트지 LLM *생성* 이벤트가 아니다 — gen_ai.system 으로 GenAI 관측에 슬롯인하되 오용 아님.
//   traceId/spanId 는 영수증 해시에서 결정론 파생(난수 없음) → 같은 영수증 → 같은 span(재현·테스트 가능).
export const OTEL_SCOPE = "agent-receipt";
export const OTEL_GENAI = {
  system: "gen_ai.system",
  operation: "gen_ai.operation.name",
} as const;

interface VReceiptShape {
  kind?: unknown;
  receiptId?: unknown;
  contentHash?: unknown;
  surface?: unknown;
  verdict?: unknown;
  summary?: unknown;
  verifiedAt?: unknown;
  tool?: unknown;
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface KeyValue { key: string; value: AnyValue }

function anyValue(v: string | number | boolean): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}
const kv = (key: string, v: string | number | boolean): KeyValue => ({ key, value: anyValue(v) });
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// verifiedAt(ISO) → unix nano 문자열. 파싱 실패 시 "0"(결정론·발명 없음).
function unixNano(verifiedAt: unknown): string {
  if (typeof verifiedAt !== "string") return "0";
  const ms = Date.parse(verifiedAt);
  return Number.isFinite(ms) ? String(ms) + "000000" : "0";
}

// 순수함수: Verification Receipt → OTLP traces JSON(resourceSpans). span 1개=검증 1건.
export function buildOtelSpans(r: VReceiptShape): Record<string, unknown> {
  const receiptId = typeof r.receiptId === "string" ? r.receiptId : "";
  const contentHash = typeof r.contentHash === "string" ? r.contentHash.replace(/^sha256:/, "") : "";
  const surface = typeof r.surface === "string" ? r.surface : "unknown";
  const verdict = typeof r.verdict === "string" ? r.verdict : "unknown";
  const traceId = (sha(contentHash || receiptId) + "0".repeat(32)).slice(0, 32); // 16 bytes hex
  const spanId = (sha(receiptId || contentHash) + "0".repeat(16)).slice(0, 16); // 8 bytes hex
  const t = unixNano(r.verifiedAt);

  const attrs: KeyValue[] = [
    kv(OTEL_GENAI.system, "agent-receipt"),
    kv(OTEL_GENAI.operation, "verify"),
    kv("agent_receipt.event", "claim-verification"), // 비-LLM 검증 이벤트(정직)
    kv("agent_receipt.surface", surface),
    kv("agent_receipt.verdict", verdict),
    kv("agent_receipt.receipt_id", receiptId),
    kv("agent_receipt.content_hash", contentHash),
  ];
  if (r.summary && typeof r.summary === "object" && !Array.isArray(r.summary)) {
    for (const [k, v] of Object.entries(r.summary as Record<string, unknown>)) {
      if (typeof v === "number") attrs.push(kv(`agent_receipt.summary.${k}`, v));
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", "agent-receipt")] },
        scopeSpans: [
          {
            scope: { name: OTEL_SCOPE },
            spans: [
              {
                traceId,
                spanId,
                name: `verify:${surface}`,
                kind: 1, // SPAN_KIND_INTERNAL
                startTimeUnixNano: t,
                endTimeUnixNano: t,
                attributes: attrs,
                status: { code: verdict === "pass" ? 1 : verdict === "fail" ? 2 : 0 }, // OK / ERROR / UNSET
              },
            ],
          },
        ],
      },
    ],
  };
}

// 한 줄 요약(로그 파이프라인용) — OTLP 아님·grep 친화.
export function otelLine(r: VReceiptShape): string {
  const s = r.summary && typeof r.summary === "object" ? (r.summary as Record<string, unknown>) : {};
  const kvs = Object.entries(s).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k}=${v}`).join(" ");
  return `agent-receipt verify surface=${typeof r.surface === "string" ? r.surface : "?"} verdict=${typeof r.verdict === "string" ? r.verdict : "?"} receipt_id=${typeof r.receiptId === "string" ? r.receiptId.slice(0, 12) : "?"} ${kvs}`.trim();
}

/**
 * `agent-receipt otel --receipt <verification-receipt.json> [--format otlp|line]`
 *  검증 영수증을 OTLP traces JSON(기본) 또는 한 줄 로그로 방출. exporter/collector 는 사용자 몫(deps-0).
 */
export function runOtel(receiptArg: string | undefined, opts: { format?: string } = {}): never {
  if (!receiptArg) {
    console.error("otel: --receipt <verification-receipt.json> 가 필요합니다.");
    process.exit(2);
  }
  const p = isAbsolute(receiptArg) ? receiptArg : join(process.cwd(), receiptArg);
  if (!existsSync(p)) {
    console.error(`otel: 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  let receipt: VReceiptShape;
  try {
    receipt = JSON.parse(readFileSync(p, "utf8")) as VReceiptShape;
  } catch {
    console.error(`otel: JSON 파싱 실패: ${receiptArg}`);
    process.exit(2);
  }
  if (receipt.kind !== "verification-receipt" || typeof receipt.contentHash !== "string") {
    console.error("otel: verification-receipt 가 아닙니다(kind='verification-receipt'·contentHash 필요).");
    process.exit(2);
  }
  if (opts.format === "line") {
    process.stdout.write(otelLine(receipt) + "\n");
  } else {
    process.stdout.write(JSON.stringify(buildOtelSpans(receipt), null, 2) + "\n");
  }
  process.stderr.write("note: OTLP JSON/로그를 stdout 으로만 방출 — SDK/exporter 미번들(deps-0). collector 로의 전송은 사용자 파이프라인 몫. 검증(비-LLM) 이벤트입니다.\n");
  process.exit(0);
}
