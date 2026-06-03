// agent-receipt 0.9.1 — close-recon tool-output 회귀 테스트 (프레임워크 없음 — node + tsx)
//
// 실행: npx tsx test/close-recon-tool-output.test.ts
//
// 검증(실사용 결함 #4/#5): close-recon 의 clean-gate 는 .agent-guard/ 도구 산출물
//   (audit-packs/notes/decisions/receipts/keys/...)을 "사용자 변경"으로 오해하면 안 된다.
//   - tool-output untracked 만 있으면 → 정상 종료(exit 0)  [audit-packs 때문에 실패하면 안 됨]
//   - 진짜 사용자 untracked 가 있으면 → 거부(exit 1, reset 안 함)
// run-fixtures.ts 패턴 계승: OS tmpdir 격리 repo + 실제 CLI 서브프로세스.

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
  GIT_AUTHOR_DATE: "2025-01-01T00:00:00 +0000",
  GIT_COMMITTER_DATE: "2025-01-01T00:00:00 +0000",
  AGENT_RECEIPT_NO_NET: "1", // 결정론(네트워크 무관) — 이 테스트는 close-recon 만 본다.
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: ENV,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function run(cwd: string, command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(tsxBin, [cli, command, ...args], { cwd, env: ENV, encoding: "utf8" });
  if (res.error) throw new Error(`서브프로세스 spawn 실패(${command}): ${res.error.message}`);
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// recon 세션이 시작된 격리 repo(.agent-guard/contract.yaml + begin --kind recon).
function reconRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "ag-corcon-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "f.txt"), "base content\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  mkdirSync(join(repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(repo, ".agent-guard", "contract.yaml"), `id: corcon\nscope:\n  allowed_paths:\n    - "**"\n`);
  const b = run(repo, "begin", ["--kind", "recon"]);
  assert.equal(b.status, 0, `begin --kind recon 는 exit 0 이어야 함 (stderr=${b.stderr})`);
  return repo;
}

const TESTS: Array<{ name: string; run: () => void }> = [
  {
    name: "tool-output untracked(audit-packs/notes/decisions) → close-recon 정상 종료(exit 0)",
    run: () => {
      const repo = reconRepo();
      // baseline 이후 생성된 도구 산출물 untracked — clean-gate 에서 무시되어야 한다.
      for (const rel of [
        join(".agent-guard", "audit-packs", "foo", "a.json"),
        join(".agent-guard", "notes", "n.json"),
        join(".agent-guard", "decisions", "d.json"),
        join(".agent-guard", "receipts", "r.json.sig.json"),
        join(".agent-guard", "receipts", "r.json.approval.json"),
      ]) {
        const p = join(repo, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "{}\n");
      }
      const r = run(repo, "close-recon", []);
      assert.equal(r.status, 0, `tool-output 만 있을 때 close-recon 은 exit 0 이어야 함 (stdout=${r.stdout}\nstderr=${r.stderr})`);
      assert.ok(r.stdout.includes("정찰 세션 종료"), "성공 메시지(정찰 세션 종료)가 있어야 함");
    },
  },
  {
    name: "진짜 사용자 untracked → close-recon 거부(exit 1, reset 안 함)",
    run: () => {
      const repo = reconRepo();
      writeFileSync(join(repo, "userfile.txt"), "real user change\n"); // 도구 산출물 아님
      const r = run(repo, "close-recon", []);
      assert.equal(r.status, 1, `진짜 변경이 있으면 close-recon 은 exit 1 이어야 함 (stdout=${r.stdout})`);
      assert.ok(r.stdout.includes("변경 감지"), "거부 메시지(변경 감지)가 있어야 함");
      assert.ok(existsSync(join(repo, ".agent-guard", "session.json")), "거부 시 baseline(session.json) 을 reset 하면 안 됨");
    },
  },
];

let failures = 0;
console.log(`\nagent-receipt close-recon tool-output tests (${TESTS.length})\n`);
for (const t of TESTS) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${t.name}\n      ${(e as Error).message}`);
  }
}
if (failures) {
  console.error(`\n${failures}/${TESTS.length} FAILED\n`);
  process.exit(1);
}
console.log(`\nAll ${TESTS.length} passed\n`);
