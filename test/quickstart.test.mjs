// v0.20 결정4·5 e2e — quickstart(인쇄 우선·--write 기록) + share 별칭(산출 byte 동일) + done 다음행동 분기.
// `node test/quickstart.test.mjs`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const mk = (sfx) => {
  const d = join(process.env.TMPDIR || "/tmp", `ar-qs-${sfx}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: d, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: d, stdio: "ignore" });
  return d;
};
const run = (cwd, args) => spawnSync("node", [CLI, ...args], { cwd, encoding: "utf8" });

// 1) quickstart 인쇄 전용 — 파일시스템 무변경(print-first)
const d1 = mk("print");
const before = readdirSync(d1).sort().join(",");
let r = run(d1, ["quickstart"]);
check("quickstart 기본 = 인쇄만·무변경", () => {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("인쇄 전용") && r.stdout.includes("만드는 것:"), "안내 인쇄");
  assert.ok(r.stdout.includes("--write"), "기록 경로 안내");
  assert.equal(readdirSync(d1).sort().join(","), before, "파일시스템 무변경");
  assert.ok(!existsSync(join(d1, ".agent-guard")), ".agent-guard 미생성");
});

// 2) --write — 계약+정책 생성·begin 은 실행 안 함·재실행은 skip
r = run(d1, ["quickstart", "--write"]);
check("quickstart --write = 실제 기록(계약·정책)·begin 은 안내만", () => {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(d1, ".agent-guard", "contract.yaml")), "계약 생성");
  assert.ok(existsSync(join(d1, ".agent-guard", "policy.yaml")), "정책 생성");
  assert.ok(!existsSync(join(d1, ".agent-guard", "session.json")), "begin 미실행(kind 는 사람 선택)");
});
r = run(d1, ["quickstart", "--write"]);
check("재실행 멱등 — 있으면 skip 표시", () => assert.ok(r.stdout.includes("이미 있음(skip)"), r.stdout));

// 3) share 별칭 — share-proof 와 산출 byte 동일(같은 저장 receipt)
const d2 = mk("alias");
writeFileSync(join(d2, "f.txt"), "x\n");
execFileSync("git", ["add", "-A"], { cwd: d2, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "init"], { cwd: d2, stdio: "ignore" });
run(d2, ["init", "--preset", "generic"]);
run(d2, ["begin", "--kind", "implementation", "--objective", "환불 API 추가(모델 변경 없음)"]);
writeFileSync(join(d2, "f.txt"), "x\ny\n");
const doneOut = run(d2, ["done"]);
check("사전조건: done PASS + 다음행동(share) 안내", () => {
  assert.equal(doneOut.status, 0, doneOut.stdout);
  assert.ok(doneOut.stdout.includes("판정: PASS"), "PASS");
  assert.ok(doneOut.stdout.includes("다음 행동:") && doneOut.stdout.includes("share-proof"), "결정4 PASS 분기");
  assert.ok(/① .*share-proof.*② .*PR.*③ .*verify-proof/.test(doneOut.stdout), "배치A-4: PASS 순서 고정(①share→②PR→③보존/검증)");
});
run(d2, ["share-proof", "--out", "a.html"]);
run(d2, ["share", "--out", "b.html"]);
check("share 별칭 = share-proof 와 byte 동일", () => {
  assert.equal(readFileSync(join(d2, "a.html"), "utf8"), readFileSync(join(d2, "b.html"), "utf8"));
});
check("배치A-6: objective — receipt 기록 + share-proof 자가보고 접두(세탁 차단)", () => {
  const rdir = join(d2, ".agent-guard", "receipts");
  const rj = JSON.parse(readFileSync(join(rdir, readdirSync(rdir).filter((n) => n.endsWith(".json") && !n.includes("approval")).sort().pop()), "utf8"));
  assert.equal(rj.session.objective, "환불 API 추가(모델 변경 없음)", "session.objective 기록");
  const h = readFileSync(join(d2, "a.html"), "utf8");
  assert.ok(h.includes("Session objective (self-reported, unverified") && h.includes("환불 API"), "자가보고 접두 고정");
  const idx = h.indexOf("Session objective");
  assert.ok(idx > h.indexOf("contracted as"), "계약 문장 아래 배치(최상단 아님 — DA-2)");
});

// 4) done INCOMPLETE 분기 — begin 없는 새 repo
const d3 = mk("inc");
writeFileSync(join(d3, "g.txt"), "1\n");
execFileSync("git", ["add", "-A"], { cwd: d3, stdio: "ignore" });
execFileSync("git", ["commit", "-m", "init"], { cwd: d3, stdio: "ignore" });
run(d3, ["init", "--preset", "generic"]);
writeFileSync(join(d3, "g.txt"), "1\n2\n");
r = run(d3, ["done"]);
check("done INCOMPLETE 분기 — begin 재측정 안내", () => {
  assert.ok(r.stdout.includes("INCOMPLETE"), "판정");
  assert.ok(r.stdout.includes("다음 행동:") && r.stdout.includes("begin` 후 재측정"), "결정4 INCOMPLETE 분기");
});

for (const d of [d1, d2, d3]) rmSync(d, { recursive: true, force: true });
if (fail.length) {
  console.error(`quickstart.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`quickstart.test: OK (${pass}) — 인쇄 우선·--write 기록·멱등 skip·share 별칭 byte 동일·done 분기(PASS/INCOMPLETE)`);
