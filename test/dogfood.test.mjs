// dogfood 스크립트 정확성 게이트 — 스크립트 자체는 항상 exit 0(비차단)이므로,
// "영수증이 실제 생성되고·graph 가 읽고·tampered 가 표시되고·재실행 시 축적"은 여기서 못 박는다.
// 격리: DOGFOOD_OUT_DIR 임시 디렉터리 — 실축적(.agent-guard/vreceipts) 무접점.
// `node test/dogfood.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildViewData, buildSummary, buildHistory } from "../dist/graph.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(join(tmpdir(), "ardogfood-"));
const runScript = () =>
  execFileSync("node", [join(root, "scripts", "dogfood.mjs")], { cwd: root, encoding: "utf8", env: { ...process.env, DOGFOOD_OUT_DIR: out } });

const first = runScript();

check("1회차: 영수증 4건(research pass/fail/newchecks·council) + 변조 교보재 1건 생성", () => {
  const files = readdirSync(out).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 5);
  assert.ok(files.includes("vr-tampered-exhibit.json"));
});
check("신규 5종 커버(Phase5): schema/version/file 픽스처가 전부 verified 로 자기영수증에 실림", () => {
  const rows = buildViewData(out);
  const nc = rows.find((r) => r.subject.includes("schema/version/file checks sample"));
  assert.ok(nc, "newchecks 영수증 없음");
  assert.equal(nc.verdict, "pass");
  const kinds = new Set(nc.claims.flatMap((c) => Object.entries(c.checks).filter(([, v]) => v === "verified").map(([k]) => k)));
  for (const k of ["schema", "version", "file", "artifact"]) assert.ok(kinds.has(k), `누락: ${k}`);
});
check("생성된 영수증을 graph 가 바로 읽음(소비 가능)", () => {
  const rows = buildViewData(out);
  assert.equal(rows.length, 5);
  assert.ok(rows.some((r) => r.surface === "research") && rows.some((r) => r.surface === "council"));
});
check("tampered tier 실물 검증: 교보재만 봉인 실패로 표시", () => {
  const rows = buildViewData(out);
  const s = buildSummary(rows);
  assert.equal(s.tamperedCount, 1); // 교보재 1건만 — 정상 영수증은 봉인 무결
});
check("실패 이벤트: fail 픽스처의 citation not-found 가 실데이터로 잡힘", () => {
  const rows = buildViewData(out);
  const failed = rows.filter((r) => r.verdict === "fail");
  assert.ok(failed.length >= 1);
  assert.ok(failed.some((r) => r.claims.some((c) => c.failures.some((f) => f.check === "citation"))));
});
check("요약 출력: 비차단 규율 문구 존재", () => {
  assert.ok(first.includes("dogfood(자기 영수증) 요약"));
});

// 2회차 실행 = 축적(history 가 실데이터로 자람)
runScript();
check("2회차: 영수증 누적(5→9·교보재는 고정 1개 유지)", () => {
  const files = readdirSync(out).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 9); // 4 신규 + 기존 4 + 교보재 1(덮어쓰기)
});
check("history 실데이터: 같은 주장(fingerprint)이 2회차에 걸쳐 쌓임", () => {
  const rows = buildViewData(out);
  const withClaim = rows.find((r) => r.claims.length && r.verdict === "fail" && !r.subject.includes("TAMPERED"));
  const fp = withClaim.claims[0].fingerprint;
  const h = buildHistory(rows, { claim: fp });
  assert.ok(h.timeline.length >= 2); // 실행 횟수만큼 자람
  assert.equal(h.timeline[1].changes.newFailures.length, 0); // 같은 픽스처 → 직전 대비 변화 없음(정직)
});

rmSync(out, { recursive: true, force: true });

if (fail.length) { console.error(`dogfood: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`dogfood: ${pass} pass ✅`);
