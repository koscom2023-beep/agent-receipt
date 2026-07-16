// P0-3 (정본 2026-07-16): `.agent-guard/` 분류가 실제 verify 배선에서 맞게 도는지 통합 검증.
//
// 단위 분류(agentguard-class.test.mjs)와 별개로, 여기서는 진짜 CLI `verify` 를 격리 repo 에서 돌려
// owner 필수 시험 #1·#5 를 실측한다. 골든이 이미 덮는 것(#2 제어→CONTROL_PLANE_TOUCHED, #3 .env→FAIL,
// #4 제품 범위밖→FAIL)은 여기서 반복하지 않는다.
//
//   #1 runtime output 만 생성  → out-of-scope 0 (제품 변경으로 세지 않음, PASS)
//   #5 runtime + 진짜 위반 공존 → runtime 은 빠지고 진짜 위반만 남는다(FAIL, 목록에 runtime 없음)
//
// run-fixtures.ts / close-recon 패턴 계승: OS tmpdir 격리 repo + 실제 CLI 서브프로세스.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");

if (!existsSync(tsxBin)) {
  console.error(`ENV ERROR: tsx 없음 (${tsxBin}). 먼저 'npm install'.`);
  process.exit(1);
}

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  AGENT_RECEIPT_NO_NET: "1",
  NO_COLOR: "1",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: ENV,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function verify(cwd: string): { status: number | null; stdout: string } {
  const res = spawnSync(tsxBin, [cli, "verify"], { cwd, env: ENV, encoding: "utf8" });
  if (res.error) throw new Error(`verify spawn 실패: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout ?? "" };
}

// src/** 만 허용하는 계약을 깐 격리 repo(baseline 없음 = full-tree 검사).
function repoWithContract(): string {
  const base = mkdtempSync(join(tmpdir(), "ag-agguard-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "src", "app.ts"), "export const a = 1;\n");
  mkdirSync(join(repo, ".agent-guard"), { recursive: true });
  writeFileSync(
    join(repo, ".agent-guard", "contract.yaml"),
    [
      "id: t",
      "title: t",
      "mode: patch_only",
      "scope:",
      "  allowed_paths:",
      '    - "src/**"',
      "  denied_paths:",
      '    - ".env*"',
      "git:",
      "  require_no_denied_path_diff: true",
      "  require_only_allowed_files_staged: false",
      "  require_no_staged_untracked: false",
      "",
    ].join("\n"),
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  return repo;
}

// ── #1: runtime output 만 생성 → out-of-scope 0, PASS ──
{
  const repo = repoWithContract();
  mkdirSync(join(repo, ".agent-guard", "receipts"), { recursive: true });
  writeFileSync(join(repo, ".agent-guard", "receipts", "r.json"), "{}\n"); // 도구 자기 산출물
  writeFileSync(join(repo, ".agent-guard", "session.json"), '{"baselineHead":"x"}\n');
  const { status, stdout } = verify(repo);
  assert.equal(status, 0, "#1 runtime output 만 있으면 PASS 여야 한다");
  assert.match(stdout, /PASS/, "#1 PASS 표기");
  assert.doesNotMatch(stdout, /범위밖/, "#1 도구 산출물은 범위밖으로 세지 않는다");
}

// ── #5: runtime output + 진짜 범위 밖 변경 공존 → FAIL, 목록엔 진짜 위반만 ──
{
  const repo = repoWithContract();
  mkdirSync(join(repo, ".agent-guard", "receipts"), { recursive: true });
  writeFileSync(join(repo, ".agent-guard", "receipts", "r.json"), "{}\n"); // 제외 대상
  writeFileSync(join(repo, "unexpected.py"), "x = 1\n"); // 진짜 범위 밖(src/** 밖)
  const { status, stdout } = verify(repo);
  assert.equal(status, 1, "#5 진짜 위반이 있으면 FAIL");
  assert.match(stdout, /unexpected\.py/, "#5 진짜 위반은 목록에 남는다");
  assert.doesNotMatch(stdout, /receipts\/r\.json/, "#5 runtime output 은 위반 목록에서 빠진다");
}

console.log("agentguard-verify.test.ts OK");
