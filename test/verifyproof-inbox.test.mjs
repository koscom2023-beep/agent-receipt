// v0.21 결정7·8 e2e — verify-proof(정상 통과·변조 격추·사람말) + inbox(버킷·창·구버전·파싱실패 자백).
// `node test/verifyproof-inbox.test.mjs`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
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

const repo = join(process.env.TMPDIR || "/tmp", `ar-vp-${process.pid}`);
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
git("init"); git("config", "user.email", "a@b.c"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "s.txt"), "quote me\n");
git("add", "-A"); git("commit", "-m", "init");
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8" });

// ── 번들 생성 체인(실물): done → vreceipt → predicate --sign → bundle ──
run(["init", "--preset", "generic"]);
run(["begin", "--kind", "implementation"]);
writeFileSync(join(repo, "s.txt"), "quote me\nmore\n");
run(["done"]);
writeFileSync(join(repo, "c.json"), JSON.stringify({ query: "t", claims: [{ statement: "q", quotedText: "quote me", sourceFile: "s.txt" }] }));
mkdirSync(join(repo, ".agent-guard", "vreceipts"), { recursive: true });
run(["research", "verify", "--file", "c.json", "--out", ".agent-guard/vreceipts/r1.json"]);
const b = run(["share-proof", "--bundle", "--out", ".agent-guard/pb", "--evidence-dir", ".agent-guard/vreceipts"]);
check("사전조건: bundle 생성", () => assert.equal(b.status, 0, b.stdout + b.stderr));

// 1) 정상 번들 → 통과(exit 0) · Rekor 없음은 skip(정직)
let r = run(["verify-proof", ".agent-guard/pb"]);
check("정상 번들 = 통과 + 네트워크 0 명시 + rekor skip", () => {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("✅ receipt-hash"), "봉인 재계산 OK");
  assert.ok(r.stdout.includes("✅ evidence-replay"), "evidence replay OK");
  assert.ok(r.stdout.includes("네트워크 0"), "오프라인 명시");
  assert.ok(r.stdout.includes("anchor.rekor.json 없음"), "없는 건 없다고(skip)");
});

// 2) receipt.json 변조 → 격추(exit 1) + 사람말
const rp = join(repo, ".agent-guard", "pb", "receipt.json");
const orig = readFileSync(rp, "utf8");
writeFileSync(rp, orig.replace('"touched"', '"touched_x"').replace("touched_x", "touched").replace('"ok": true', '"ok": true').replace(/"added":\s*\d+/, '"added": 999'));
r = run(["verify-proof", ".agent-guard/pb"]);
check("영수증 변조 = ❌ receipt-hash + 사람말(변조 신호)", () => {
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}`);
  assert.ok(r.stdout.includes("❌ receipt-hash") && r.stdout.includes("변조 신호"), r.stdout);
});
writeFileSync(rp, orig); // 복원

// 3) evidence 변조 → 격추
const ev = join(repo, ".agent-guard", "pb", "evidence", "r1.json");
const evOrig = readFileSync(ev, "utf8");
{
  const evObj = JSON.parse(evOrig);
  evObj.__tampered = 1; // 본문 변경 확정(필드명 추측 없이) — contentHash 재계산이 어긋나야 정상
  writeFileSync(ev, JSON.stringify(evObj, null, 2));
}
r = run(["verify-proof", ".agent-guard/pb"]);
check("evidence 변조 = ❌ evidence-replay", () => {
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("❌ evidence-replay"), r.stdout);
});
writeFileSync(ev, evOrig);

// 4) 입력 오류 = exit 2
check("번들 아님(빈 폴더) = exit 2 + 안내", () => {
  mkdirSync(join(repo, "notabundle"), { recursive: true });
  const r2 = run(["verify-proof", "notabundle"]);
  assert.equal(r2.status, 2);
  assert.ok(r2.stderr.includes("receipt.json"), r2.stderr);
});

// ── inbox — 픽스처 영수증 3+1(브로큰) ──
const rdir = join(repo, ".agent-guard", "receipts");
const mkReceipt = (name, ts, verdict, denied = [], critical = []) => {
  const base = JSON.parse(orig); // 실물 스키마 재사용(발명 최소)
  base.timestamp = ts;
  base.deniedHits = denied;
  base.criticalPaths = critical;
  if (verdict) base.verdict = { verdict, reasons: ["x"] };
  else delete base.verdict;
  writeFileSync(join(rdir, name), JSON.stringify(base, null, 2));
};
mkReceipt("receipt-2026-07-01T00-00-00-000Z.json", "2026-07-01T00:00:00.000Z", "PASS");
mkReceipt("receipt-2026-07-02T00-00-00-000Z.json", "2026-07-02T00:00:00.000Z", "FAIL", [".env"]);
mkReceipt("receipt-2020-01-01T00-00-00-000Z.json", "2020-01-01T00:00:00.000Z", "PASS"); // 90일 창 밖
mkReceipt("receipt-2026-07-03T00-00-00-000Z.json", "2026-07-03T00:00:00.000Z", null, [], [{ glob: "pay/**", touched: ["pay/a.ts"] }]); // 구버전(판정 없음)
writeFileSync(join(rdir, "receipt-broken.json"), "{not json");
const j = run(["inbox", "--format", "json"]);
check("inbox JSON 계약 — 버킷·창·구버전·파싱실패 자백", () => {
  assert.equal(j.status, 0, j.stderr);
  const d = JSON.parse(j.stdout);
  assert.equal(d.schemaVersion, "inbox/1");
  assert.equal(d.summary.broken, 1, "파싱 실패 카운트 자백");
  assert.ok(d.summary.byVerdict.none >= 1, "구버전=판정없음 버킷");
  assert.ok(d.summary.byVerdict.FAIL >= 1 && d.summary.byVerdict.PASS >= 1);
  assert.ok(d.rows.every((x) => x.timestamp >= "2026-"), "90일 창: 2020년 영수증 제외");
  assert.equal(d.summary.scanned - d.rows.length >= 1, true, "잘림을 scanned 로 자백");
  assert.ok(d.summary.deniedTouched >= 1 && d.summary.criticalTouched >= 1, "중립 카운트");
});
const jAll = run(["inbox", "--format", "json", "--all"]);
check("--all = 창 해제(2020년 포함)", () => {
  const d = JSON.parse(jAll.stdout);
  assert.ok(d.rows.some((x) => x.timestamp.startsWith("2020-")), "전체 창");
  assert.equal(d.windowDays, null);
});
r = run(["inbox", "--out", ".agent-guard/inbox.html"]);
check("inbox HTML — 필터 UI + 외부 리소스 0 + 판단어 없음", () => {
  assert.equal(r.status, 0, r.stderr);
  const h = readFileSync(join(repo, ".agent-guard", "inbox.html"), "utf8");
  assert.ok(h.includes("판정 없음") && h.includes("f-v"), "버킷+필터");
  assert.ok(!h.includes("src=") && !h.includes("http://") && !h.includes("https://"), "외부 로드 0");
  assert.ok(h.includes("판단 아님"), "중립 명시");
});
check("배치B-7: 프리셋 — 사실 조건명·해시 공유·checks 키·판단어 0", () => {
  const h = readFileSync(join(repo, ".agent-guard", "inbox.html"), "utf8");
  for (const lbl of ["FAIL만", "금지경로 접촉", "고위험경로·검사 없음", "미검토"]) assert.ok(h.includes(lbl), `프리셋: ${lbl}`);
  assert.ok(h.includes("#preset=") || h.includes("preset="), "URL 해시 공유");
  assert.ok(h.includes("critical-nocheck") && h.includes("checksTotal===0"), "복합 조건=사실식");
  assert.ok(!/안전|추천|권장|safe/i.test(h), "프리셋 판단어 0");
  const d = JSON.parse(run(["inbox", "--format", "json", "--all"]).stdout);
  assert.ok(d.rows.every((x) => typeof x.checksTotal === "number" && typeof x.checksFailed === "number"), "checks 키 additive");
});

rmSync(repo, { recursive: true, force: true });
if (fail.length) {
  console.error(`verifyproof-inbox.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`verifyproof-inbox.test: OK (${pass}) — 통과/변조 격추(receipt·evidence)/exit2 + inbox 버킷·창·자백·HTML`);
