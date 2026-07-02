// site/replay-lite.js(브라우저 봉인 검사기) ↔ dist/vreceipt(진본) 동등성 잠금 — council DA① 수용 조건.
// 실영수증(CLI 봉인) + 바이트 변조 + receiptId 변조, 세 변형 모두 verdict 완전 일치해야 한다.
// `node test/site-replay-equivalence.test.mjs`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { replayVerificationReceipt } = await import(join(root, "dist", "vreceipt.js"));
const { replayLite } = await import(join(root, "site", "replay-lite.js")); // node 22+/20 은 globalThis.crypto(WebCrypto) 제공

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

const dir = mkdtempSync(join(tmpdir(), "arreplaylite-"));
writeFileSync(join(dir, "rep.json"), JSON.stringify({ query: "eq", claims: [{ statement: "s", quotedText: "hello", sourceText: "hello world" }] }));
const rc = join(dir, "vr.json");
execFileSync("node", [join(root, "dist", "cli.js"), "research", "verify", "--file", join(dir, "rep.json"), "--out", rc], { encoding: "utf8" });
const good = JSON.parse(readFileSync(rc, "utf8"));

const variants = {
  "정상(무결)": good,
  "바이트 변조(verdict 뒤집기)": { ...good, verdict: good.verdict === "pass" ? "fail" : "pass" },
  "receiptId 변조": { ...good, receiptId: "0".repeat(64) },
};
for (const [name, r] of Object.entries(variants)) {
  check(`동등성 — ${name}`, async () => {}); // placeholder 순서 고정용
}
// async 비교는 top-level await 로 순차 수행
let i = 0;
for (const [name, r] of Object.entries(variants)) {
  const real = replayVerificationReceipt(r);
  const lite = await replayLite(r);
  const idx = i++;
  if (lite.contentHashOk !== real.contentHashOk || lite.receiptIdOk !== real.receiptIdOk) {
    fail.push(`동등성 — ${name}: lite(${lite.contentHashOk},${lite.receiptIdOk}) ≠ real(${real.contentHashOk},${real.receiptIdOk})`);
    pass--; // placeholder 상쇄
  }
}
check("정상본은 실제로 무결(전제 확인)", async () => {});
{
  const lite = await replayLite(good);
  if (!(lite.contentHashOk && lite.receiptIdOk && lite.tampered === false)) { fail.push("정상본 무결 전제 실패"); pass--; }
}
check("비-영수증/깨진 입력 → 정직 거절(크래시 0)", async () => {});
{
  const a = await replayLite({ kind: "something-else" });
  const b = await replayLite(null);
  if (!(a.ok === false && a.reason === "not-a-verification-receipt" && b.ok === false)) { fail.push("거절 경로 실패"); pass--; }
}

rmSync(dir, { recursive: true, force: true });
if (fail.length) { console.error(`site-replay-equivalence: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`site-replay-equivalence: ${pass} pass ✅`);
