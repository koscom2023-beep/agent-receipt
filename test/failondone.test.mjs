// P1 v0.18 D3 — policy fail_on_done e2e(임시 repo·실 CLI).
// 수용기준(council): 미설정=현행 exit 불변 · 임계 도달 시 exit 1 + 원인 자백 1줄 · 판정/reasons 불변.
// `node test/failondone.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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

const repo = join(process.env.TMPDIR || "/tmp", `ar-failondone-${process.pid}`);
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
git("init");
git("config", "user.email", "a@b.c");
git("config", "user.name", "t");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "f.txt"), "hello\n");
git("add", "-A");
git("commit", "-m", "init");
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8" });
run(["init", "--preset", "generic"]);
writeFileSync(join(repo, "f.txt"), "hello\nchanged\n"); // 변경 1건(계약 위반 아님)

// 1) 미설정 — begin 안 함 → 판정 INCOMPLETE 인데 exit 0 (현행 불변)
let r = run(["done"]);
check("미설정: INCOMPLETE 여도 exit 0(현행)", () => {
  assert.equal(r.status, 0, `exit=${r.status}\n${r.stdout}`);
  assert.ok(r.stdout.includes("INCOMPLETE"), "판정 INCOMPLETE");
  assert.ok(r.stdout.includes("[no-baseline]") && r.stdout.includes("고치는 법"), "D2 코드+fix 병기");
  assert.ok(!r.stdout.includes("fail_on_done"), "미설정이면 자백줄 없음");
});

// 2) fail_on_done: fail — INCOMPLETE 는 임계 미달 → exit 0 (명시용 값)
const policyPath = join(repo, ".agent-guard", "policy.yaml");
writeFileSync(policyPath, "fail_on_done: fail\n");
r = run(["done"]);
check("fail 임계: INCOMPLETE 는 exit 0", () => assert.equal(r.status, 0, r.stdout));

// 3) fail_on_done: incomplete — INCOMPLETE → exit 1 + 자백 1줄(판정/reasons 그대로)
writeFileSync(policyPath, "fail_on_done: incomplete\n");
r = run(["done"]);
check("incomplete 임계: INCOMPLETE → exit 1 + 자백", () => {
  assert.equal(r.status, 1, `exit=${r.status}\n${r.stdout}`);
  assert.ok(r.stdout.includes("fail_on_done=incomplete"), "원인 자백(어느 임계가 올렸나)");
  assert.ok(r.stdout.includes("판정: INCOMPLETE"), "판정 자체는 불변(게이트는 exit 만)");
});

// 4) begin 후 PASS — warn 임계여도 PASS(severity 0)는 exit 0
writeFileSync(policyPath, "fail_on_done: warn\n");
run(["begin", "--kind", "implementation"]);
writeFileSync(join(repo, "f.txt"), "hello\nchanged\nmore\n");
r = run(["done"]);
check("warn 임계: PASS 는 exit 0", () => {
  assert.equal(r.status, 0, `exit=${r.status}\n${r.stdout}`);
  assert.ok(r.stdout.includes("판정: PASS"), "PASS");
});

// 5) policy show 에 설정 표시
r = run(["policy", "show"]);
check("policy show 에 fail_on_done 표시", () => assert.ok(r.stdout.includes("fail_on_done   : warn"), r.stdout));

// 6) 깨진 policy — 게이트 침묵 꺼짐 방지(자백 1줄·review 반영)
writeFileSync(policyPath, "fail_on_done: [broken\n");
r = run(["done"]);
check("깨진 policy: 자백 1줄 + fail-open(exit 0)", () => {
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.stdout.includes("policy.yaml 오류") && r.stdout.includes("미적용"), "침묵 방지 자백");
});

rmSync(repo, { recursive: true, force: true });
if (fail.length) {
  console.error(`failondone.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`failondone.test: OK (${pass}) — 미설정 불변·임계별 exit·자백줄·판정 불변·show 표시`);
