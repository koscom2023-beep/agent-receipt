// git/의존성 사실 조회 surface — 실제 임시 git 저장소로 검증(모킹 없음).
// `node test/gitfacts.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommitExists, resolveChangedFiles, resolveDiffText, resolveDependencyMap, resolveFileExists, resolveReceiptFacts } from "../dist/gitfacts.js";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

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

// ── Phase5: 파일 실재 + 영수증 인용 사실(실파일·모킹 없음) ──
check("resolveFileExists: 실재 true·부재 false", () => {
  assert.equal(resolveFileExists(pkgPath), true);
  assert.equal(resolveFileExists(join(dir, "no-such-file.xyz")), false);
});
{
  // 실제 CLI 로 진짜 영수증 생산(손 JSON 아님 — 봉인이 진짜여야 replay 재계산이 의미 있음)
  const repPath = join(dir, "rep.json");
  writeFileSync(repPath, JSON.stringify({ query: "q", claims: [{ statement: "s", quotedText: "hello", sourceText: "hello world" }] }));
  const outPath = join(dir, "vr.json");
  execFileSync("node", [cliPath, "research", "verify", "--file", repPath, "--out", outPath], { encoding: "utf8" });
  check("resolveReceiptFacts: 실제 영수증 → found+VR+봉인 재계산 전부 true", () => {
    const f = resolveReceiptFacts(outPath);
    assert.equal(f.found, true);
    assert.equal(f.isVerificationReceipt, true);
    assert.equal(f.contentHashOk, true);
    assert.equal(f.receiptIdOk, true);
    assert.ok(typeof f.actualReceiptId === "string" && f.actualReceiptId.length >= 16);
  });
  check("resolveReceiptFacts: 1바이트 변조 → contentHashOk=false(변조 실검출)", () => {
    const tampered = readFileSync(outPath, "utf8").replace('"verdict": "pass"', '"verdict": "fail"').replace('"verdict":"pass"', '"verdict":"fail"');
    const tPath = join(dir, "vr-tampered.json");
    writeFileSync(tPath, tampered);
    const f = resolveReceiptFacts(tPath);
    assert.equal(f.found, true);
    assert.equal(f.contentHashOk, false);
  });
  check("resolveReceiptFacts: 파일 부재/JSON 아님 → found=false", () => {
    assert.equal(resolveReceiptFacts(join(dir, "nope.json")).found, false);
    const badPath = join(dir, "bad-receipt.json");
    writeFileSync(badPath, "{not json");
    assert.equal(resolveReceiptFacts(badPath).found, false);
  });
  check("resolveReceiptFacts: 다른 kind(작업영수증류) → found=true·isVR=false", () => {
    const wPath = join(dir, "work.json");
    writeFileSync(wPath, JSON.stringify({ schemaVersion: "1.0", ok: true }));
    const f = resolveReceiptFacts(wPath);
    assert.equal(f.found, true);
    assert.equal(f.isVerificationReceipt, false);
  });
}

rmSync(dir, { recursive: true, force: true });

if (fail.length) { console.error(`gitfacts: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`gitfacts: ${pass} pass ✅`);
