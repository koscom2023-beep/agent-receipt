// D3 — Claim↔Git 대조 SSOT(claimdiff). 이전 claims.ts/auditpack.ts 중복·백슬래시 divergence 통합.
// `node test/claimdiff.test.mjs`.
import assert from "node:assert/strict";
import { diffClaimField, normalizeClaimPath, claimPathSet } from "../dist/claimdiff.js";
import { claimVerify } from "../dist/auditpack.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// ── 정규화: ./ 제거 + 백슬래시 통일 ──
check("normalizeClaimPath: ./ 제거", () => assert.equal(normalizeClaimPath("./src/a.ts"), "src/a.ts"));
check("normalizeClaimPath: 백슬래시→슬래시", () => assert.equal(normalizeClaimPath("src\\a.ts"), "src/a.ts"));

// ── diffClaimField: 일치/숨김/초과 ──
check("일치 → ok", () => assert.equal(diffClaimField(["src/a.ts"], ["src/a.ts"]).ok, true));
check("git에 있고 AI 미주장 → hidden", () => {
  const d = diffClaimField(["src/a.ts"], ["src/a.ts", "pkg.json"]);
  assert.deepEqual(d.hidden, ["pkg.json"]); assert.equal(d.ok, false);
});
check("AI 주장 git 없음 → extra", () => {
  const d = diffClaimField(["src/a.ts", "ghost.ts"], ["src/a.ts"]);
  assert.deepEqual(d.extra, ["ghost.ts"]);
});
check("비배열/비문자열 방어 → 빈 대조", () => assert.equal(diffClaimField(null, []).ok, true));

// ── 버그 정정 핵심: Windows 백슬래시 claim ↔ git forward-slash 거짓 불일치 없어야 ──
check("D3 fix: 백슬래시 claim ↔ 슬래시 git → 일치(거짓 불일치 아님)", () => {
  assert.equal(diffClaimField(["src\\a.ts"], ["src/a.ts"]).ok, true);
});

// ── auditpack.claimVerify 도 같은 SSOT 경유(이전엔 백슬래시 미정규화 버그) ──
check("claimVerify: 백슬래시 changedFiles ↔ 슬래시 touched → ok(버그 해소)", () => {
  const r = claimVerify({ changedFiles: ["src\\a.ts"] }, ["src/a.ts"], [], []);
  assert.equal(r.ok, true);
});
check("claimVerify: 숨긴 변경 탐지 유지", () => {
  const r = claimVerify({ changedFiles: ["src/a.ts"] }, ["src/a.ts", "secret.ts"], [], []);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fields[0].hidden, ["secret.ts"]);
});

if (fail.length) { console.error(`claimdiff: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`claimdiff: ${pass} pass ✅`);
