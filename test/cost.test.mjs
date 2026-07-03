// 화폐화: 가격표 + transcript 리더 + cost — council 2026-07-03 수락 기준. `node test/cost.test.mjs`.
import assert from "node:assert/strict";
import { costOf, priceFor, normalizeModelId, fmtUsd } from "../dist/pricing.js";
import { summarizeTranscriptLines, projectDirName, CONTEXT_BLOAT_TOKENS } from "../dist/transcript.js";
import { costLines, sessionCostLine } from "../dist/cost.js";

let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

// ── 가격표 ──
check("가격표: opus/fable/sonnet/haiku 실측 리스트가", () => {
  assert.equal(priceFor("claude-opus-4-8").output, 25);
  assert.equal(priceFor("claude-fable-5").input, 10);
  assert.equal(priceFor("claude-fable-5").cacheWrite5m, 12.5);
  assert.equal(priceFor("claude-haiku-4-5").cacheRead, 0.1);
});

check("미지 모델 → null (추정 날조 금지)", () => {
  assert.equal(priceFor("gpt-4"), null);
  assert.equal(priceFor(undefined), null);
});

check("스냅샷 접미만 정규화(claude-haiku-4-5-20251001)", () => {
  assert.equal(normalizeModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(priceFor("claude-haiku-4-5-20251001").input, 1);
  assert.equal(normalizeModelId("claude-fable-5"), "claude-fable-5"); // 접미 없으면 그대로
});

check("costOf: 알려진 배수로 정확 계산", () => {
  // fable: input 1M×$10 + output 1M×$50 + cacheRead 1M×$1 + cacheCreation 1M×$12.5(5m) = 73.5
  const c = costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 1e6 }, "claude-fable-5");
  assert.ok(Math.abs(c - 73.5) < 1e-6, `got ${c}`);
});

check("costOf: 1h 캐시생성 분리 시 2× 적용", () => {
  const c = costOf({ input: 0, output: 0, cacheRead: 0, cacheCreation: 1e6 }, "claude-fable-5", 1e6);
  assert.ok(Math.abs(c - 20) < 1e-6, `got ${c}`); // 전부 1h → $20
});

check("costOf 미지 모델 → null", () => {
  assert.equal(costOf({ input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 }, "gpt-4"), null);
});

check("fmtUsd: <0.01 처리", () => {
  assert.equal(fmtUsd(0.003), "<$0.01");
  assert.equal(fmtUsd(1.5), "$1.50");
  assert.equal(fmtUsd(null), "?");
});

// ── transcript 파서 ──
const mkLine = (o) => JSON.stringify(o);
const asst = (model, usage, tools = []) =>
  mkLine({ timestamp: "2026-07-03T00:00:00.000Z", message: { role: "assistant", model, usage, content: tools.map((t) => ({ type: "tool_use", name: t })) } });

check("usage 필드 없음 → supported:false (버전 감지·조용한 오계량 금지)", () => {
  const s = summarizeTranscriptLines([mkLine({ message: { role: "assistant", content: [] } })]);
  assert.equal(s.supported, false);
  assert.ok(s.reason.includes("지원 포맷이 아닙니다") || s.reason.includes("usage"));
});

check("정상 파싱: 토큰 합산·모델별·도구 카운트·비용", () => {
  const lines = [
    asst("claude-fable-5", { input_tokens: 100, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ["Bash", "Read"]),
    asst("claude-opus-4-8", { input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ["Bash"]),
  ];
  const s = summarizeTranscriptLines(lines);
  assert.equal(s.supported, true);
  assert.equal(s.messages, 2);
  assert.equal(s.tokens.output, 2e6);
  // fable output 1M×$50=50 + opus output 1M×$25=25 = 75 (+ fable input 100×$10/M≈0)
  assert.ok(Math.abs(s.cost - 75) < 0.01, `cost ${s.cost}`);
  assert.equal(s.byModel[0].model, "claude-fable-5"); // 비용 내림차순
  assert.equal(s.toolCounts.find((t) => t.tool === "Bash").count, 2);
});

check("값 미저장: 파서 산출물에 프롬프트/파일내용 문자열 0", () => {
  const lines = [
    mkLine({ message: { role: "user", content: [{ type: "text", text: "SECRET_PROMPT_BODY" }] } }),
    asst("claude-fable-5", { input_tokens: 10, output_tokens: 10 }),
  ];
  const s = summarizeTranscriptLines(lines);
  assert.ok(!JSON.stringify(s).includes("SECRET_PROMPT_BODY"), "프롬프트 본문이 요약에 유출");
});

check("깨진 라인 무시하고 계속(fragile 포맷 방어)", () => {
  const s = summarizeTranscriptLines(["{broken", asst("claude-fable-5", { input_tokens: 10, output_tokens: 10 }), ""]);
  assert.equal(s.supported, true);
  assert.equal(s.messages, 1);
});

check("컨텍스트 정점 = max(input+cacheRead+cacheCreation)", () => {
  const s = summarizeTranscriptLines([
    asst("claude-fable-5", { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }),
    asst("claude-fable-5", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 300000, cache_creation_input_tokens: 0 }),
  ]);
  assert.equal(s.contextPeak, 300010);
});

check("가격 미상 모델 섞임 → hasUnpriced true·부분 합산", () => {
  const s = summarizeTranscriptLines([
    asst("claude-fable-5", { input_tokens: 0, output_tokens: 1e6 }),
    asst("mystery-model-9", { input_tokens: 0, output_tokens: 1e6 }),
  ]);
  assert.equal(s.hasUnpriced, true);
  assert.ok(Math.abs(s.cost - 50) < 0.01); // fable만 계산됨
});

check("projectDirName: cwd → 디렉터리명(실측 규칙)", () => {
  assert.equal(projectDirName("/home/sah4444/agent-receipt"), "-home-sah4444-agent-receipt");
});

// ── 표시 ──
check("costLines: 청구서 아님·캐시 오해 방지 문구", () => {
  const s = summarizeTranscriptLines([asst("claude-fable-5", { input_tokens: 10, output_tokens: 1e6 })]);
  const L = costLines(s);
  assert.ok(L[0].includes("청구서 아님"));
  assert.ok(L.some((l) => l.includes("claude-fable-5")));
});

check("costLines: 컨텍스트 bloat 임계 넘으면 새 세션 권유", () => {
  const s = summarizeTranscriptLines([
    asst("claude-fable-5", { input_tokens: CONTEXT_BLOAT_TOKENS + 1, output_tokens: 5 }),
  ]);
  assert.ok(costLines(s).some((l) => l.includes("새 세션")));
});

check("costLines supported:false → 이유 1줄", () => {
  const L = costLines({ supported: false, reason: "없음" });
  assert.equal(L.length, 1);
  assert.ok(L[0].includes("없음"));
});

console.log(`cost.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
