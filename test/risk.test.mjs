// AI 작업 위험 신호(12차 council) — risk: A2 범위·A3 미검토수용·A4 민감/불안정. 부채 '측정' 아님·점수0·per-task.
// `node test/risk.test.mjs`.
import assert from "node:assert/strict";
import { buildRiskFlags, renderRiskMd, renderRiskJson } from "../dist/risk.js";

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

const base = { ok: true, contractId: "demo", title: null, touched: [], deniedHits: [], outOfScope: [], criticalPaths: [], checks: [{ name: "build", ok: true }], magnitude: { filesChanged: 1, added: 5, deleted: 0, newFiles: 0 } };
const codes = (r) => buildRiskFlags(r).flags.map((f) => f.code);

// A2 — 범위·고위험
check("A2 — denied/outOfScope/critical 플래그", () => {
  assert.ok(codes({ ...base, deniedHits: ["package.json"] }).includes("denied-path"));
  assert.ok(codes({ ...base, outOfScope: ["x.ts"] }).includes("out-of-scope"));
  assert.ok(codes({ ...base, criticalPaths: [{ glob: ".env*", touched: [".env"] }] }).includes("critical-path"));
});
check("A2 — critical 안 닿으면 플래그 없음", () => {
  assert.ok(!codes({ ...base, criticalPaths: [{ glob: ".env*", touched: [] }] }).includes("critical-path"));
});

// A3 — 미검토 수용(큰 변경 + 검사 미통과/0 + 테스트경로 0)
check("A3 — 큰 변경+검사0+테스트0 → unreviewed-acceptance", () => {
  const r = { ...base, magnitude: { filesChanged: 5, added: 100, deleted: 0, newFiles: 3 }, checks: [], touched: ["src/a.ts", "src/b.ts"] };
  assert.ok(codes(r).includes("unreviewed-acceptance"));
});
check("A3 — 테스트 경로 파일 있으면 플래그 없음", () => {
  const r = { ...base, magnitude: { filesChanged: 5, added: 100, deleted: 0, newFiles: 0 }, checks: [], touched: ["src/a.ts", "src/a.test.ts"] };
  assert.ok(!codes(r).includes("unreviewed-acceptance"), "테스트 경로 추가됨 → 미검토수용 아님");
});
check("A3 — 검사 통과면 플래그 없음", () => {
  const r = { ...base, magnitude: { filesChanged: 9, added: 300, deleted: 0, newFiles: 0 }, checks: [{ name: "t", ok: true }], touched: ["src/a.ts"] };
  assert.ok(!codes(r).includes("unreviewed-acceptance"));
});
check("A3 — 작은 변경은 플래그 없음(사소)", () => {
  const r = { ...base, magnitude: { filesChanged: 1, added: 10, deleted: 0, newFiles: 0 }, checks: [], touched: ["src/a.ts"] };
  assert.ok(!codes(r).includes("unreviewed-acceptance"));
});

// A4 — 민감/불안정(capture)
check("A4 — secret/external/created-deleted 플래그", () => {
  const r = { ...base, actions: [], actionsSummary: { secretFilesRead: 1, externalCalls: 2, createdThenDeleted: 1, total: 4, gitVisible: 0 } };
  const c = codes(r);
  assert.ok(c.includes("secret-read") && c.includes("external-call") && c.includes("created-deleted"));
  assert.equal(buildRiskFlags(r).captureActive, true);
});
check("A4 — capture 부재 → captureActive false(없음 아님·미관측)", () => {
  assert.equal(buildRiskFlags(base).captureActive, false); // actions 미설정
});

// 정직 — 부채 '측정' 아님·점수 없음
check("정직 라벨 — '측정 아님' + 위험 신호, 점수 단정 없음", () => {
  const md = renderRiskMd({ ...base, deniedHits: ["x"] });
  assert.ok(md.includes("측정") && md.includes("아닙니다"), "'측정 아님' 라벨 누락");
  assert.ok(md.includes("위험 신호"), "위험 신호 프레이밍 누락");
  assert.ok(!/위험 점수|risk score|grade\s*[A-F]/.test(md), "점수/등급 단정 누출");
});
check("json — kind=ai-work-risk-signals · 'NOT a code-quality' note", () => {
  const o = JSON.parse(renderRiskJson({ ...base, deniedHits: ["x"] }));
  assert.equal(o.kind, "ai-work-risk-signals");
  assert.ok(o.note.toLowerCase().includes("not a code-quality") || o.note.toLowerCase().includes("not a"));
  assert.ok(Array.isArray(o.flags));
});

if (fail.length) {
  console.error(`risk: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`risk: ${pass} pass, 0 fail`);
