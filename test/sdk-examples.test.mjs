// SDK 예제 스모크 — 예제가 썩은 채 문서에 남는 것을 차단(실행·exit·출력 단언).
// `node test/sdk-examples.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) => {
  try {
    return { out: execFileSync("node", args, { cwd: root, encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout ?? "") + String(e.stderr ?? ""), code: typeof e.status === "number" ? e.status : -1 };
  }
};

// 픽스처: base(실패 1) / head(같은 실패 지속 + 신규 1)
const base = mkdtempSync(join(tmpdir(), "arsdkb-"));
const head = mkdtempSync(join(tmpdir(), "arsdkh-"));
const claim = (st, status) => ({ statement: st, sourceUrl: "http://u", checks: { citation: status }, verdict: status === "verified" ? "verified" : "failed" });
writeFileSync(join(base, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "e1", subject: "ProjZ", verdict: "fail", surface: "research", input: { sha256: "sZ" }, verifiedAt: "2026-07-01T00:00:00Z", results: [claim("CLAIM-1", "not-found")] }));
writeFileSync(join(head, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "e2", subject: "ProjZ", verdict: "fail", surface: "research", input: { sha256: "sZ" }, verifiedAt: "2026-07-02T00:00:00Z", results: [claim("CLAIM-1", "not-found")] }));
writeFileSync(join(head, "b.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "e3", subject: "ProjY", verdict: "fail", surface: "research", input: { sha256: "sY" }, verifiedAt: "2026-07-02T00:00:00Z", results: [claim("CLAIM-2", "not-found")] }));

check("예제① read-receipts: 요약+subject 상태판 출력·exit 0", () => {
  const r = run([join(root, "examples", "read-receipts.mjs"), head]);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("영수증 2건") && r.out.includes("ProjZ") && r.out.includes("ProjY"));
});
check("예제② history-query: 접두 해석+타임라인·첫 등장 표시", () => {
  const r = run([join(root, "examples", "history-query.mjs"), head, "cfp1:"]);
  // head 에 지문 2개 → 접두 모호 = exit 2(정직한 실패)
  assert.equal(r.code, 2);
  assert.ok(r.out.includes("접두 모호"));
  const one = run([join(root, "examples", "history-query.mjs"), base, "cfp1:"]);
  assert.equal(one.code, 0); // base 엔 지문 1개 → 유일
  assert.ok(one.out.includes("이력 1건") && one.out.includes("첫 등장"));
});
check("예제③ diff-ci: 신규 실패 → exit 1 + bySubject 출력", () => {
  const r = run([join(root, "examples", "diff-ci.mjs"), base, head]);
  assert.equal(r.code, 1); // ProjY 신규
  assert.ok(r.out.includes("신규 1") && r.out.includes("ProjY: 신규 1") && r.out.includes("ProjZ") && r.out.includes("지속 1"));
  const same = run([join(root, "examples", "diff-ci.mjs"), head, head]);
  assert.equal(same.code, 0); // 자기 자신 → 신규 0
});

rmSync(base, { recursive: true, force: true });
rmSync(head, { recursive: true, force: true });

if (fail.length) { console.error(`sdk-examples: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`sdk-examples: ${pass} pass ✅`);
