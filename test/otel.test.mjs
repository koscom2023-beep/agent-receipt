// R8 OpenTelemetry(OTLP) 방출 테스트 — deps-0·결정론 traceId/spanId·gen_ai 속성·status 매핑.
import assert from "node:assert";
import { buildOtelSpans, otelLine, OTEL_GENAI } from "../dist/otel.js";

const r = {
  kind: "verification-receipt",
  receiptId: "abc123def456abc123def456",
  contentHash: "deadbeef".repeat(8),
  surface: "bench",
  verdict: "pass",
  summary: { total: 12, tp: 5, fp: 1 },
  verifiedAt: "2026-07-06T00:00:00.000Z",
};

const otlp = buildOtelSpans(r);
const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
assert.equal(span.traceId.length, 32, "traceId 16 bytes hex");
assert.equal(span.spanId.length, 16, "spanId 8 bytes hex");
assert.ok(/^[0-9a-f]+$/.test(span.traceId) && /^[0-9a-f]+$/.test(span.spanId), "hex");
assert.equal(span.name, "verify:bench");
assert.equal(span.kind, 1, "INTERNAL");
assert.equal(span.status.code, 1, "pass=OK");

const attr = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
assert.equal(attr[OTEL_GENAI.system].stringValue, "agent-receipt");
assert.equal(attr[OTEL_GENAI.operation].stringValue, "verify");
assert.equal(attr["agent_receipt.event"].stringValue, "claim-verification", "비-LLM 검증 이벤트 라벨");
assert.equal(attr["agent_receipt.surface"].stringValue, "bench");
assert.equal(attr["agent_receipt.verdict"].stringValue, "pass");
assert.equal(attr["agent_receipt.summary.total"].intValue, "12", "int as string(OTLP)");
assert.equal(attr["agent_receipt.summary.tp"].intValue, "5");

// verdict fail → status ERROR(2)
assert.equal(buildOtelSpans({ ...r, verdict: "fail" }).resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);

// 결정론: 같은 영수증 → 같은 span(id 포함·난수 없음)
assert.equal(JSON.stringify(buildOtelSpans(r)), JSON.stringify(otlp));
// contentHash 다르면 traceId 다름
assert.notEqual(buildOtelSpans({ ...r, contentHash: "cafe".repeat(16) }).resourceSpans[0].scopeSpans[0].spans[0].traceId, span.traceId);

// line 포맷
assert.ok(otelLine(r).startsWith("agent-receipt verify surface=bench verdict=pass"), "line 요약");
assert.ok(otelLine(r).includes("total=12"));

console.log("otel.test: OK — OTLP span(deps-0)·결정론 traceId/spanId·gen_ai.system·pass=OK/fail=ERROR");
