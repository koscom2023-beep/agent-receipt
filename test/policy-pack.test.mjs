// 배치B-9 — 정책 프리셋 팩(client-delivery·sensitive-backend) e2e.
// 수용기준(council): 유효 YAML(스키마 파싱)·forbid_actions 포함·"제안—채택은 사용자" 명문·판단어 0.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

for (const prof of ["client-delivery", "sensitive-backend"]) {
  const d = join(process.env.TMPDIR || "/tmp", `ar-pp-${prof}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  execFileSync("git", ["init"], { cwd: d, stdio: "ignore" });
  const run = (args) => spawnSync("node", [CLI, ...args], { cwd: d, encoding: "utf8" });
  const r = run(["policy", "init", "--profile", prof]);
  check(`${prof}: init 생성`, () => assert.equal(r.status, 0, r.stderr));
  const yaml = readFileSync(join(d, ".agent-guard", "policy.yaml"), "utf8");
  check(`${prof}: 제안 명문 + forbid_actions + 판단어 0`, () => {
    assert.ok(yaml.includes("제안") && yaml.includes("사용자"), "판단 주체=사용자 명문");
    assert.ok(yaml.includes("forbid_actions:"), "행위 클래스 기본값 포함");
    assert.ok(!/안전|추천|권장/.test(yaml), "판단어 0");
  });
  const show = run(["policy", "show"]);
  check(`${prof}: 스키마 유효(show 파싱 OK) + forbid_actions 표시`, () => {
    assert.equal(show.status, 0, show.stdout + show.stderr);
    assert.ok(show.stdout.includes("forbid_actions"), show.stdout);
  });
  rmSync(d, { recursive: true, force: true });
}
if (fail.length) { console.error(`policy-pack.test: FAIL ${fail.length}\n - ` + fail.join("\n - ")); process.exit(1); }
console.log(`policy-pack.test: OK (${pass}) — 2팩 생성·스키마 유효·제안 명문·forbid_actions·판단어 0`);
