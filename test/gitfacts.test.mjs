// git/의존성 사실 조회 surface — 실제 임시 git 저장소로 검증(모킹 없음).
// `node test/gitfacts.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommitExists, resolveChangedFiles, resolveDiffText, resolveDependencyMap } from "../dist/gitfacts.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// 실제 임시 git 저장소 구성(모킹 아님) — 커밋 1개, 파일 하나 추가.
const dir = mkdtempSync(join(tmpdir(), "argitfacts-"));
const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
git(["init", "-q"]);
git(["config", "user.email", "t@example.com"]);
git(["config", "user.name", "t"]);
writeFileSync(join(dir, "a.ts"), "export function add(a,b){return a+b}\n");
git(["add", "a.ts"]);
git(["commit", "-q", "-m", "feat: add()"]);
const realCommit = git(["rev-parse", "HEAD"]).trim();
const fakeCommit = "0".repeat(40); // 40자 유효 hex 형식이지만 실재하지 않는 커밋

check("resolveCommitExists: 실재 커밋 → true", () => assert.equal(resolveCommitExists(realCommit, dir), true));
check("resolveCommitExists: 형식은 맞지만 없는 커밋 → false(진짜 mismatch)", () => assert.equal(resolveCommitExists(fakeCommit, dir), false));
check("resolveCommitExists: 커밋해시 형식 자체가 아님 → null(no-basis)", () => assert.equal(resolveCommitExists("not-a-hash", dir), null));
check("resolveCommitExists: 레포 아닌 디렉터리 → null(no-basis)", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "argitfacts-norepo-"));
  assert.equal(resolveCommitExists(realCommit, notRepo), null);
  rmSync(notRepo, { recursive: true, force: true });
});

check("resolveChangedFiles: 실제 변경파일 목록에 a.ts 포함", () => {
  const files = resolveChangedFiles(realCommit, dir);
  assert.ok(files && files.includes("a.ts"));
});
check("resolveChangedFiles: 없는 커밋 → null", () => assert.equal(resolveChangedFiles(fakeCommit, dir), null));

check("resolveDiffText: 실제 diff 에 추가된 라인 포함", () => {
  const diff = resolveDiffText(realCommit, "a.ts", dir);
  assert.ok(diff && diff.includes("export function add"));
});

// 의존성 맵 — 실제 package.json 유사 파일.
const pkgPath = join(dir, "package.json");
writeFileSync(pkgPath, JSON.stringify({ dependencies: { zod: "^3.23.8" }, devDependencies: { typescript: "5.4.0" } }));
check("resolveDependencyMap: dependencies+devDependencies 병합", () => {
  const m = resolveDependencyMap(pkgPath);
  assert.equal(m.zod, "^3.23.8");
  assert.equal(m.typescript, "5.4.0");
});
check("resolveDependencyMap: 파일 없음 → null", () => assert.equal(resolveDependencyMap(join(dir, "nope.json")), null));
check("resolveDependencyMap: JSON 파싱 실패 → null", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  assert.equal(resolveDependencyMap(bad), null);
});

rmSync(dir, { recursive: true, force: true });

if (fail.length) { console.error(`gitfacts: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`gitfacts: ${pass} pass ✅`);
