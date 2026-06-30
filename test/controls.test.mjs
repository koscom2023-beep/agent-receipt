// 규제 매핑(8차 council) — 읽기전용 투영 `controls`. 신호→관련 통제 '증거'(준수 아님).
// 잠금: 활성 신호만 · checks0=noVerification · anchor 격상 · 정직 동사('evidence relevant to'만·'compliant with/satisfies' 0) · ISO=likely.
// `node test/controls.test.mjs`.
import assert from "node:assert/strict";
import { buildControlMap, renderControlMd, renderControlJson, CONTROL_REGISTRY, ANCHOR_ENTRY, tierOf } from "../dist/controls.js";

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

const base = { contractId: "demo", title: null, ok: true, deniedHits: [], checks: [], criticalPaths: [] };
const sigs = (r, anchor = false) => buildControlMap(r, anchor).entries.map((e) => e.signal);

// 활성 신호 로직
check("빈 receipt → auditLogIntegrity 만 + noVerification", () => {
  const m = buildControlMap(base, false);
  assert.deepEqual(m.entries.map((e) => e.signal), ["auditLogIntegrity"]);
  assert.equal(m.noVerification, true);
});
check("secretFilesRead>0 → secretFilesRead 활성", () => {
  assert.ok(sigs({ ...base, actionsSummary: { secretFilesRead: 1, externalCalls: 0, createdThenDeleted: 0, total: 1, gitVisible: 0 } }).includes("secretFilesRead"));
});
check("externalCalls>0 → externalCalls 활성", () => {
  assert.ok(sigs({ ...base, actionsSummary: { secretFilesRead: 0, externalCalls: 2, createdThenDeleted: 0, total: 2, gitVisible: 0 } }).includes("externalCalls"));
});
check("createdThenDeleted>0 → 활성", () => {
  assert.ok(sigs({ ...base, actionsSummary: { secretFilesRead: 0, externalCalls: 0, createdThenDeleted: 1, total: 1, gitVisible: 0 } }).includes("createdThenDeleted"));
});
check("deniedHits → 활성", () => {
  assert.ok(sigs({ ...base, deniedHits: ["package.json"] }).includes("deniedHits"));
});
check("checks 있으면 requiredChecks 활성 + noVerification=false", () => {
  const r = { ...base, checks: [{ name: "build", exitCode: 0, requiredExit: 0, ok: true }] };
  assert.ok(sigs(r).includes("requiredChecks"));
  assert.equal(buildControlMap(r, false).noVerification, false);
});
check("criticalPaths touched → 활성", () => {
  assert.ok(sigs({ ...base, criticalPaths: [{ glob: ".env*", touched: [".env"] }] }).includes("criticalPaths"));
});
check("criticalPaths 안 닿음 → 비활성", () => {
  assert.ok(!sigs({ ...base, criticalPaths: [{ glob: ".env*", touched: [] }] }).includes("criticalPaths"));
});
check("Rekor 앵커 있으면 rekorAnchor 격상 엔트리 추가(맨 끝)", () => {
  const s = sigs(base, true);
  assert.equal(s[s.length - 1], "rekorAnchor");
});

// 정직 프레이밍
check("정직 동사 — 'compliant with/satisfies/certifies' 0건, 'evidence relevant to' 존재", () => {
  const md = renderControlMd({ ...base, actionsSummary: { secretFilesRead: 1, externalCalls: 0, createdThenDeleted: 0, total: 1, gitVisible: 0 } }, false).toLowerCase();
  assert.ok(!md.includes("compliant with"), "준수 단정 동사 누출");
  assert.ok(!md.includes("satisfies"), "satisfies 누출");
  assert.ok(!md.includes("certifies"), "certifies 누출");
  assert.ok(md.includes("evidence relevant to"), "관련증거 프레이밍 누락");
  assert.ok(md.includes("not a compliance assessment"), "면책 누락");
});
check("ISO 엔트리는 confidence=likely + 원문확인 문구", () => {
  const isoRefs = CONTROL_REGISTRY.flatMap((e) => e.controls).filter((c) => c.framework.includes("ISO"));
  assert.ok(isoRefs.length > 0);
  assert.ok(isoRefs.every((c) => c.confidence === "likely"), "ISO 가 confirmed 로 단정됨");
  const md = renderControlMd(base, false);
  assert.ok(md.includes("verify") && md.includes("ISO/IEC 42001"), "ISO 원문확인 각주 누락");
});
check("auditLogIntegrity 엔트리에 EU AI Act Art 12/19/26(6) confirmed 포함", () => {
  const e = CONTROL_REGISTRY.find((x) => x.signal === "auditLogIntegrity");
  const eu = e.controls.filter((c) => c.framework === "EU AI Act");
  assert.ok(eu.some((c) => c.id === "Article 12") && eu.some((c) => c.id === "Article 19") && eu.some((c) => c.id === "Article 26(6)"));
  assert.ok(eu.every((c) => c.confidence === "confirmed"));
});
check("모든 엔트리에 doesNotProve 존재(과대주장 차단)", () => {
  for (const e of [...CONTROL_REGISTRY, ANCHOR_ENTRY]) assert.ok(e.doesNotProve && e.doesNotProve.length > 10, `${e.signal} doesNotProve 누락`);
});
check("json 출력 — relation=evidence-relevant-to·유효 JSON", () => {
  const o = JSON.parse(renderControlJson({ ...base, deniedHits: ["x"] }, false));
  assert.equal(o.relation, "evidence-relevant-to");
  assert.ok(o.entries.some((e) => e.signal === "deniedHits"));
  assert.ok(o.noVerification === true);
});

// ── 증거 위계 tier(11차 council·AS 1105) — A 외부앵커 > B git실측 > C capture자기보고 ──
check("tierOf — capture신호=C·git신호=B·Rekor앵커=A", () => {
  assert.equal(tierOf("secretFilesRead"), "C");
  assert.equal(tierOf("externalCalls"), "C");
  assert.equal(tierOf("deniedHits"), "B");
  assert.equal(tierOf("requiredChecks"), "B");
  assert.equal(tierOf("auditLogIntegrity"), "B");
  assert.equal(tierOf("rekorAnchor"), "A");
});
check("controls md — AS 1105 증거위계 헤더 + 신호별 tier 라벨", () => {
  const md = renderControlMd({ ...base, actionsSummary: { secretFilesRead: 1, externalCalls: 0, createdThenDeleted: 0, total: 1, gitVisible: 0 } }, false);
  assert.ok(md.includes("AS 1105"), "AS 1105 위계 헤더 누락");
  assert.ok(/tier C/.test(md), "capture 신호 tier C 라벨 누락");
});
check("controls json — entries 에 evidenceTier", () => {
  const o = JSON.parse(renderControlJson({ ...base, deniedHits: ["x"] }, false));
  const denied = o.entries.find((e) => e.signal === "deniedHits");
  assert.equal(denied.evidenceTier, "B");
});
check("controls — 모든 registry 신호에 tier 정의(드리프트 가드)", () => {
  for (const e of [...CONTROL_REGISTRY, ANCHOR_ENTRY]) assert.ok(["A", "B", "C"].includes(tierOf(e.signal)), `${e.signal} tier 미정의`);
});

if (fail.length) {
  console.error(`controls: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`controls: ${pass} pass, 0 fail`);
