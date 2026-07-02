// site/kernel.js(브라우저 변환본) ↔ dist(진본) 동등성 — "같은 커널" 주장을 기계로 잠금(DA① 응답).
// `node test/site-kernel.test.mjs` (사전: scripts/build-site-kernel.mjs 실행됨 — npm test 체인이 보장)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("node", [join(root, "scripts", "build-site-kernel.mjs")], { encoding: "utf8" });

const real = await import(join(root, "dist", "evidencekernel.js"));
const site = await import(join(root, "site", "kernel.js"));

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// 순수 종류 대표 케이스 — verdict/results 완전 일치(플레이그라운드가 다루는 6종)
const CASES = [
  [{ quotedText: "completed a SOC 2 Type I audit", sourceText: "Acme completed a SOC 2 Type I audit in March 2026" }, null],
  [{ quotedText: "has passed a SOC 2 Type II audit", sourceText: "Acme completed a SOC 2 Type I audit in March 2026" }, null],
  [{ statedValue: 6, op: "sum", operands: [1, 2, 3] }, null],
  [{ statedDate: "2026-01-05" }, "published Jan 5, 2026"],
  [{ link: "not a url" }, null],
  [{ schemaData: { n: "x" }, schemaDef: { type: "object", properties: { n: { type: "number" } } } }, null],
  [{ statedPackage: "zod", statedPackageVersion: "3.24.0", dependencyMap: { zod: "^3.23.8" } }, null],
];
check("순수 6종: dist ↔ site 변환본 evaluateClaim 결과 완전 동일", () => {
  for (const [claim, source] of CASES) {
    const a = real.evaluateClaim(claim, source);
    const b = site.evaluateClaim(claim, source);
    assert.deepEqual({ r: b.results, f: b.failed, v: b.verified }, { r: a.results, f: a.failed, v: a.verified }, JSON.stringify(claim).slice(0, 60));
  }
});
check("CHECK_KINDS/SCHEMA_VERSION 동일(스펙 표면 일치)", () => {
  assert.deepEqual([...site.CHECK_KINDS], [...real.CHECK_KINDS]);
  assert.equal(site.SCHEMA_VERSION, real.SCHEMA_VERSION);
});
check("crypto 종류는 브라우저 변환본에서 *명시* throw(침묵 오답 금지)", () => {
  assert.throws(() => site.evaluateClaim({ statedHash: "aa", content: "x" }, null), /CLI/);
  assert.throws(() => site.claimFingerprintV1({ statement: "s", checkKinds: [] }), /CLI/);
  // 진본은 정상 동작(대조)
  assert.equal(real.evaluateClaim({ statedHash: "aa", content: "x" }, null).hash, "mismatch");
});
check("변환본에 node:crypto import 잔존 0(브라우저 로드 가능성)", async () => {
  const txt = (await import("node:fs")).readFileSync(join(root, "site", "kernel.js"), "utf8");
  assert.ok(!txt.includes('from "node:crypto"'));
});

if (fail.length) { console.error(`site-kernel: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`site-kernel: ${pass} pass ✅`);
