// D4 — git↔capture 대사(reconcileCapture)를 Receipt 에 동결(present-only·해시 제외).
// `node test/recon-freeze.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

function mkRepo(sfx) {
  const repo = join(process.env.TMPDIR || "/tmp", `ar-recon-${sfx}-${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".agent-guard"), { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
  git("init"); git("config", "user.email", "a@b"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, ".agent-guard", "contract.yaml"), 'id: r\nscope:\n  allowed_paths: ["src/**"]\n  denied_paths: [".env*"]\n');
  return { repo, git };
}
const run = (repo, args, input) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8", input });
const readJson = (repo, rel) => JSON.parse(readFileSync(join(repo, rel), "utf8"));

// ── (1) capture 있으면 대사가 receipt 에 동결 ──
{
  const { repo, git } = mkRepo("cap");
  writeFileSync(join(repo, "src", "a.ts"), "1\n");
  git("add", "-A"); git("commit", "-qm", "init");
  // capture: src/a.ts 에 write 기록(→ git 변경과 matched)
  run(repo, ["capture", "--event", "post"], JSON.stringify({ session_id: "t", tool_name: "Write", tool_input: { file_path: "src/a.ts" } }));
  // git 변경: a.ts 수정(capture 있음) + b.ts 신규(capture 없음 → 미설명 잔차)
  writeFileSync(join(repo, "src", "a.ts"), "2\n");
  writeFileSync(join(repo, "src", "b.ts"), "new\n");
  run(repo, ["receipt", "--format", "json", "--out", "r.json"]);
  const r = readJson(repo, "r.json");
  check("reconciliation 필드 동결됨(capture 있을 때)", () => assert.ok(r.reconciliation && typeof r.reconciliation === "object"));
  check("대사 shape(matched/residuals/unexplained/capturedNotInGit)", () => {
    const rc = r.reconciliation;
    assert.equal(typeof rc.matched, "number");
    assert.ok(Array.isArray(rc.residuals));
    assert.equal(typeof rc.unexplained, "number");
    assert.equal(typeof rc.capturedNotInGit, "number");
  });
  check("capture 없는 git 변경(b.ts)은 잔차로 남음", () =>
    assert.ok(r.reconciliation.residuals.some((x) => x.path.includes("b.ts"))));
  check("actions 도 함께 동결(기존 패턴 불변)", () => assert.ok(Array.isArray(r.actions)));
}

// ── (2) capture 없으면 reconciliation 키 부재(기존 바이트동일 보장) ──
{
  const { repo, git } = mkRepo("nocap");
  writeFileSync(join(repo, "src", "a.ts"), "1\n");
  git("add", "-A"); git("commit", "-qm", "init");
  writeFileSync(join(repo, "src", "a.ts"), "2\n");
  run(repo, ["receipt", "--format", "json", "--out", "r.json"]);
  const r = readJson(repo, "r.json");
  check("capture 없으면 reconciliation 키 자체가 없음(present-only)", () => assert.equal("reconciliation" in r, false));
  check("capture 없으면 actions 키도 없음(불변)", () => assert.equal("actions" in r, false));
}

if (fail.length) { console.error(`recon-freeze: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`recon-freeze: ${pass} pass ✅`);
