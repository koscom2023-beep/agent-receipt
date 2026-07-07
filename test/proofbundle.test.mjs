// P2 v0.19 D6 — proof bundle e2e(임시 repo·실 CLI 체인: done→research verify→share-proof --bundle).
// 수용기준(council): 디렉터리 산출(zip 없음)·VERIFY.md 동봉(검증법+정직 경계)·anchor 없으면 그 사실 명시·evidence 복사.
// `node test/proofbundle.test.mjs`.
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

const repo = join(process.env.TMPDIR || "/tmp", `ar-proofbundle-${process.pid}`);
rmSync(repo, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
git("init");
git("config", "user.email", "a@b.c");
git("config", "user.name", "t");
git("config", "commit.gpgsign", "false");
writeFileSync(join(repo, "src.txt"), "the answer is 42\n");
git("add", "-A");
git("commit", "-m", "init");
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8" });

run(["init", "--preset", "generic"]);
run(["begin", "--kind", "implementation"]);
writeFileSync(join(repo, "src.txt"), "the answer is 42\nmore\n");
run(["done"]); // 저장 receipt 생성(번들의 원천)

// 검증엔진 영수증 1건(evidence/ 복사 대상) — 실제 research verify 로 생성(합성 금지)
writeFileSync(
  join(repo, "claims.json"),
  JSON.stringify({ query: "t", claims: [{ statement: "42 언급", quotedText: "the answer is 42", sourceFile: "src.txt" }] }),
);
mkdirSync(join(repo, ".agent-guard", "vreceipts"), { recursive: true });
const rv = run(["research", "verify", "--file", "claims.json", "--out", ".agent-guard/vreceipts/r1.json"]);
check("사전조건: research verify 영수증 생성", () => assert.equal(rv.status, 0, rv.stdout + rv.stderr));

// 번들 생성(anchor 없음 시나리오)
const bundleDir = join(repo, ".agent-guard", "pb");
const b = run(["share-proof", "--bundle", "--out", ".agent-guard/pb", "--evidence-dir", ".agent-guard/vreceipts"]);
check("bundle exit 0 + 산출 목록 출력", () => {
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.ok(b.stdout.includes("proof bundle 생성"), b.stdout);
});
check("디렉터리 구성 — index.html + receipt.json + VERIFY.md + evidence/", () => {
  assert.ok(existsSync(join(bundleDir, "index.html")), "index.html");
  assert.ok(existsSync(join(bundleDir, "receipt.json")), "receipt.json");
  assert.ok(existsSync(join(bundleDir, "VERIFY.md")), "VERIFY.md");
  assert.ok(existsSync(join(bundleDir, "evidence", "r1.json")), "evidence 복사");
});
check("receipt.json = 저장 원본 그대로(계산 없음)", () => {
  const receiptsDir = join(repo, ".agent-guard", "receipts");
  const latest = readdirSync(receiptsDir).filter((n) => n.endsWith(".json")).sort().pop();
  assert.equal(readFileSync(join(bundleDir, "receipt.json"), "utf8"), readFileSync(join(receiptsDir, latest), "utf8"));
});
check("VERIFY.md — 검증법+정직 경계+anchor 부재 명시", () => {
  const v = readFileSync(join(bundleDir, "VERIFY.md"), "utf8");
  assert.ok(v.includes("replay --receipt evidence/"), "evidence replay 안내");
  assert.ok(v.includes("not present"), "anchor 부재 명시(없는 걸 있는 척 안 함)");
  assert.ok(v.includes("tamper-evident, not non-forgeable"), "정직 경계");
  assert.ok(v.includes("not a compliance guarantee"), "컴플라이언스 비보증");
});
check("index.html — 탭 + evidence 롤업 포함(--evidence-dir 반영)", () => {
  const h = readFileSync(join(bundleDir, "index.html"), "utf8");
  assert.ok(h.includes("pt-evidence") && h.includes("Verification receipts"), "evidence 탭");
  assert.ok(!h.includes("<script"), "script 0");
});
check("번들 evidence 영수증이 replay 로 재검증됨(전달받는 쪽 절차 실증)", () => {
  const rp = run(["replay", "--receipt", ".agent-guard/pb/evidence/r1.json"]);
  assert.equal(rp.status, 0, rp.stdout + rp.stderr);
});
check("fresh 경로 + --bundle = 거부(저장 receipt 필수·exit 2)", () => {
  const tmp2 = join(process.env.TMPDIR || "/tmp", `ar-pb2-${process.pid}`);
  rmSync(tmp2, { recursive: true, force: true });
  mkdirSync(tmp2, { recursive: true });
  execFileSync("git", ["init"], { cwd: tmp2, stdio: "ignore" });
  const r2 = spawnSync("node", [CLI, "init", "--preset", "generic"], { cwd: tmp2, encoding: "utf8" });
  assert.equal(r2.status, 0, r2.stderr);
  const r3 = spawnSync("node", [CLI, "share-proof", "--bundle"], { cwd: tmp2, encoding: "utf8" });
  assert.equal(r3.status, 2, `exit=${r3.status}`);
  assert.ok(r3.stderr.includes("done"), "done 먼저 안내");
  rmSync(tmp2, { recursive: true, force: true });
});

rmSync(repo, { recursive: true, force: true });
if (fail.length) {
  console.error(`proofbundle.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`proofbundle.test: OK (${pass}) — 디렉터리 번들·원본 보존·VERIFY.md 정직·evidence replay 실증·fresh 거부`);
