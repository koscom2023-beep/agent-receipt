import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

// 자기 자신(dist/cli.js)을 서브프로세스로 호출해 임시 repo 에서 PASS/FAIL 경로를 자가검증한다.
const CLI = fileURLToPath(new URL("./cli.js", import.meta.url));

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function ar(cwd: string, args: string[]): number | null {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" }).status;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `agent-receipt selftest` — 임시 git repo 를 만들어 핵심 경로를 자가검증(설치/PATH/동작 신뢰).
 * 검사: init → 클린 verify PASS → denied(.env) verify FAIL → receipt 저장. 끝나면 임시 repo 삭제.
 * exit 0(전부 OK) / 1(하나라도 실패).
 */
export function runSelftest(): never {
  const checks: Check[] = [];
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "agent-receipt-selftest-"));
    git(dir, ["init", "-q"]);
    git(dir, ["-c", "user.email=selftest@local", "-c", "user.name=selftest", "commit", "--allow-empty", "-q", "-m", "init"]);

    const sInit = ar(dir, ["init", "--preset", "generic"]);
    checks.push({ name: "init --preset generic", ok: sInit === 0, detail: `exit ${sInit}` });

    // generic = denied-only(allowed 비어 positive scope off) → 클린 트리 verify PASS
    const sClean = ar(dir, ["verify"]);
    checks.push({ name: "클린 트리 verify PASS", ok: sClean === 0, detail: `exit ${sClean}` });

    // denied 경로(.env*) 생성 → verify FAIL(exit 1)
    writeFileSync(join(dir, ".env.local"), "SECRET=selftest\n");
    const sDenied = ar(dir, ["verify"]);
    checks.push({ name: "denied(.env) verify FAIL", ok: sDenied === 1, detail: `exit ${sDenied}` });

    // receipt 저장(상태에 따라 0/1 — 저장 자체가 성공이면 충분)
    const sReceipt = ar(dir, ["receipt"]);
    checks.push({ name: "receipt 저장", ok: sReceipt === 0 || sReceipt === 1, detail: `exit ${sReceipt}` });
  } catch (e: unknown) {
    checks.push({ name: "selftest 실행", ok: false, detail: e instanceof Error ? e.message : String(e) });
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 임시 디렉토리 정리 실패는 무시 */
      }
    }
  }

  const allOk = checks.every((c) => c.ok);
  console.log("agent-receipt selftest (임시 repo — 설치/동작 자가검증):");
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  console.log(allOk ? "결과: OK ✅ — 설치/동작 정상." : "결과: 실패 ❌ — 위 항목 확인(설치/PATH/git).");
  process.exit(allOk ? 0 : 1);
}
