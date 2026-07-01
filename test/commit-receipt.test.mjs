// 커밋-모드 영수증(receipt --committed) + 분리된 post-commit 증거 훅.
// 근본: git post-commit 은 --no-verify 로 우회되지 않으므로 게이트 우회에도 영수증이 남는다.
// `node test/commit-receipt.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
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

function mkRepo(sfx) {
  const repo = join(process.env.TMPDIR || "/tmp", `ar-commit-test-${sfx}-${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".agent-guard"), { recursive: true });
  const git = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "ignore", "ignore"] });
  git("init");
  git("config", "user.email", "a@b.c");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  return { repo, git };
}
// spawnSync → exit code 로 안 던짐(receipt 는 FAIL 시 exit 1). stdout/파일로 검증.
const run = (repo, args) => spawnSync("node", [CLI, ...args], { cwd: repo, encoding: "utf8" });
const readJson = (repo, rel) => JSON.parse(readFileSync(join(repo, rel), "utf8"));

const CONTRACT = `id: smoke
scope:
  allowed_paths: ["src/**"]
  denied_paths: [".env*"]
`;

// ── 1) 커밋-모드: --no-verify 로 커밋해도 그 커밋만 정확히 측정(증거 생존) ──
{
  const { repo, git } = mkRepo("main");
  writeFileSync(join(repo, ".agent-guard", "contract.yaml"), CONTRACT);
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "src", "a.ts"), "export const x=1\nexport const y=2\n");
  writeFileSync(join(repo, ".env"), "SECRET=abc\n"); // untracked — 커밋에 없음
  git("add", "src/a.ts");
  git("commit", "-qm", "feat", "--no-verify"); // 게이트 우회 커밋

  run(repo, ["receipt", "--committed", "--format", "json", "--out", "rc.json"]);
  const r = readJson(repo, "rc.json");
  check("커밋-모드: measuredFrom=committed:<parent>", () => assert.match(r.measuredFrom || "", /^committed:[0-9a-f]{40}$/));
  check("커밋-모드: touched=커밋 파일만(src/a.ts)", () => assert.deepEqual(r.touched, ["src/a.ts"]));
  check("커밋-모드: 미추적 .env 는 무시(denied 비어야)", () => assert.deepEqual(r.deniedHits, []));
  check("커밋-모드: magnitude=커밋 diff(+2 lines, 1 file, 1 new)", () =>
    assert.deepEqual(r.magnitude, { filesChanged: 1, added: 2, deleted: 0, newFiles: 1 }));
  check("커밋-모드: --no-verify 커밋도 영수증 생성됨(증거 생존)", () => assert.equal(r.ok, true));

  // ── 2) 기본(작업트리) 모드: measuredFrom 부재 = 바이트 호환, 작업트리 반영 ──
  run(repo, ["receipt", "--format", "json", "--out", "rw.json"]);
  const w = readJson(repo, "rw.json");
  check("기본 모드: measuredFrom 필드 부재(작업트리·기존 바이트동일)", () => assert.equal("measuredFrom" in w, false));
  check("기본 모드: 작업트리의 .env 를 본다(커밋-모드와 다름)", () => assert.ok(w.touched.includes(".env")));
}

// ── 3) 루트 커밋 엣지: 부모 없음 → 빈 트리 base, 크래시 없이 전부 신규 측정 ──
{
  const { repo, git } = mkRepo("root");
  writeFileSync(join(repo, ".agent-guard", "contract.yaml"), CONTRACT);
  writeFileSync(join(repo, "src", "only.ts"), "export const z=3\n");
  git("add", "src/only.ts", ".agent-guard/contract.yaml");
  git("commit", "-qm", "root", "--no-verify"); // 첫(루트) 커밋
  const res = run(repo, ["receipt", "--committed", "--format", "json", "--out", "rr.json"]);
  check("루트 커밋: 크래시 없음(exit 0/1)", () => assert.ok(res.status === 0 || res.status === 1));
  const r = readJson(repo, "rr.json");
  check("루트 커밋: base=빈트리 → 커밋 파일 측정(src/only.ts 포함)", () => assert.ok(r.touched.includes("src/only.ts")));
  check("루트 커밋: measuredFrom=committed:<빈트리>", () =>
    assert.equal(r.measuredFrom, "committed:4b825dc642cb6eb9a060e54bf8d69288fbee4904"));
}

// ── 4) install-hooks: post-commit 증거 훅 배선(게이트와 분리) ──
{
  const { repo } = mkRepo("hooks");
  const res = run(repo, ["install-hooks"]);
  check("install-hooks: 성공(exit 0)", () => assert.equal(res.status, 0));
  const pc = join(repo, ".git", "hooks", "post-commit");
  check("post-commit 훅 설치됨", () => assert.ok(existsSync(pc)));
  const body = existsSync(pc) ? readFileSync(pc, "utf8") : "";
  check("post-commit 이 receipt --committed 를 호출(증거)", () => assert.match(body, /receipt --committed/));
  check("post-commit 은 항상 exit 0(비차단)", () => assert.match(body, /exit 0\s*$/));
  const prec = readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8");
  check("pre-commit 은 게이트만(commit-check·증거 아님)", () =>
    assert.ok(prec.includes("commit-check") && !prec.includes("receipt --committed")));
  // uninstall 은 우리가 만든 post-commit 도 제거
  run(repo, ["uninstall-hooks"]);
  check("uninstall-hooks: post-commit 제거됨", () => assert.ok(!existsSync(pc)));
}

if (fail.length) {
  console.error(`commit-receipt: ${pass} pass, ${fail.length} FAIL`);
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`commit-receipt: ${pass} pass ✅`);
