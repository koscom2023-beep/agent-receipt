// R5 검증 능력 → 규제 조항 크로스워크 테스트 — 발명 0(프레임워크 3종만)·정직 라벨·관계=관련(준수 아님).
import assert from "node:assert";
import { VERIFICATION_CROSSWALK, renderCrosswalkMd, renderCrosswalkJson } from "../dist/controls.js";

const FRAMEWORKS = new Set(["EU AI Act", "SOC 2 TSC", "ISO/IEC 42001"]);
const CONF = new Set(["confirmed", "likely"]);

assert.ok(VERIFICATION_CROSSWALK.length >= 6, "능력 6+ 매핑");

for (const e of VERIFICATION_CROSSWALK) {
  assert.ok(typeof e.signal === "string" && e.signal.length > 0, "signal");
  assert.ok(typeof e.label === "string" && e.label.length > 0, "label");
  assert.ok(typeof e.doesNotProve === "string" && e.doesNotProve.length > 20, `doesNotProve 실질: ${e.signal}`);
  assert.ok(Array.isArray(e.controls) && e.controls.length > 0, "controls");
  for (const c of e.controls) {
    assert.ok(FRAMEWORKS.has(c.framework), `발명 프레임워크 금지: ${c.framework}`);
    assert.ok(CONF.has(c.confidence), `confidence 2종만: ${c.confidence}`);
    assert.ok(typeof c.id === "string" && c.id.length > 0 && typeof c.title === "string" && c.title.length > 0, "clause id/title");
    // SoT 규율: ISO 는 paywalled → 반드시 likely, EU/SOC2 공개 → confirmed
    if (c.framework === "ISO/IEC 42001") assert.equal(c.confidence, "likely", "ISO=likely");
    else assert.equal(c.confidence, "confirmed", `${c.framework}=confirmed`);
  }
}

// 정직 프레이밍: 관계=관련(준수 아님)·정확성 보장 아님
const md = renderCrosswalkMd();
assert.ok(md.includes("evidence relevant to"), "관계=evidence relevant to");
assert.ok(md.includes("준수(compliance)가 아니다"), "준수 아님 disclaimer");
assert.ok(md.includes("does NOT establish the AI system's overall accuracy"), "정확성 보장 아님 caveat");
assert.ok(!/guarantees compliance|is compliant with|satisfies Article/i.test(md), "과대매핑 문구 금지");

// JSON 관계 라벨
const j = JSON.parse(renderCrosswalkJson());
assert.equal(j.relationship, "evidence-relevant-to (NOT compliance)");
assert.equal(j.entries.length, VERIFICATION_CROSSWALK.length);

// 결정론
assert.equal(renderCrosswalkMd(), md);

console.log(`crosswalk.test: OK — ${VERIFICATION_CROSSWALK.length}능력·프레임워크 3종만·ISO=likely·관계=관련(준수 아님)·정확성 보장 아님`);
