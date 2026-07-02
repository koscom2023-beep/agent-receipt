// research 인용검증 커널 — quotedText 가 출처의 리터럴 부분문자열인지 결정론 대조(비-LLM).
// `node test/research-verify.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCitationInText, normalizeForCitation, checkClaimCitation, stripHtml } from "../dist/research.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// ── 정규화: 공백 collapse + trim ──
check("normalize: 공백 collapse", () => assert.equal(normalizeForCitation("a   b\n c"), "a b c"));
check("normalize: trim", () => assert.equal(normalizeForCitation("  x  "), "x"));

// ── 커널: 실재 인용 pass / 날조 fail ──
check("verified: 정확한 부분문자열", () =>
  assert.equal(verifyCitationInText("the sky is blue", "Studies show the sky is blue today."), true));
check("verified: 공백 차이는 정규화되어 일치", () =>
  assert.equal(verifyCitationInText("the sky   is\nblue", "the sky is blue"), true));
check("not-found: 날조 인용은 출처에 없음", () =>
  assert.equal(verifyCitationInText("the sky is green", "the sky is blue"), false));
check("not-found: 빈 인용은 검증 불가(false)", () =>
  assert.equal(verifyCitationInText("   ", "anything"), false));
check("not-found: 인용이 출처보다 길면 false", () =>
  assert.equal(verifyCitationInText("a very long quote not present", "short"), false));

// ── checkClaimCitation: 상태 판정(verified / not-found / no-source) ──
check("status verified: sourceText 인라인에 인용 실재", () =>
  assert.equal(checkClaimCitation({ quotedText: "hello world", sourceText: "say hello world now" }), "verified"));
check("status not-found: sourceText 있으나 인용 없음", () =>
  assert.equal(checkClaimCitation({ quotedText: "ghost quote", sourceText: "real text only" }), "not-found"));
check("status no-source: 출처 없음", () =>
  assert.equal(checkClaimCitation({ quotedText: "orphan" }), "no-source"));
check("status no-source: 인용 없음", () =>
  assert.equal(checkClaimCitation({ sourceText: "some source" }), "no-source"));
check("status no-source: 못 읽는 sourceFile", () =>
  assert.equal(checkClaimCitation({ quotedText: "x", sourceFile: "/no/such/file/xyz-987.txt" }), "no-source"));

// ── stripHtml (--fetch 라이브 대조용 HTML→텍스트) ──
check("stripHtml: 태그 제거", () => assert.ok(!stripHtml("<p>hello <b>world</b></p>").includes("<")));
check("stripHtml: 인용문 텍스트 보존", () => {
  const t = stripHtml("<div><p>the sky is blue</p></div>");
  assert.equal(verifyCitationInText("the sky is blue", t), true);
});
check("stripHtml: script 블록 제거", () => assert.ok(!stripHtml("<script>var x='the sky is blue'</script><p>hi</p>").includes("var x")));
check("stripHtml: 엔티티 디코드", () => assert.ok(stripHtml("a &amp; b &lt;c&gt;").includes("a & b <c>")));

// ── Phase4 end-to-end: research verify CLI가 실제 git 저장소 대상 commit/fileChanged/diffContains/
//    schema/version 을 실제로 검증하나(모킹 없음 — 실 CLI 서브프로세스+실 임시 레포) ──
{
  const dir = mkdtempSync(join(tmpdir(), "argraph-e2e-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.ts"), "export function add(a,b){return a+b}\n");
  git(["add", "a.ts"]);
  git(["commit", "-q", "-m", "feat: add()"]);
  const realCommit = git(["rev-parse", "HEAD"]).trim();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^3.23.8" } }));

  const reportPath = join(dir, "report.json");
  const report = {
    query: "Phase4 e2e",
    claims: [
      { statement: "실재 커밋", statedCommit: realCommit, repoDir: dir },
      { statement: "실재 변경파일", statedCommit: realCommit, statedChangedFile: "a.ts", repoDir: dir },
      { statement: "실재 diff 내용", statedCommit: realCommit, statedChangedFile: "a.ts", statedDiffText: "export function add", repoDir: dir },
      { statement: "스키마 일치", schemaData: { n: 1 }, schemaDef: { type: "object", required: ["n"] } },
      { statement: "버전 일치(range 접두 벗김)", statedPackage: "zod", statedPackageVersion: "3.23.8", dependencyFile: join(dir, "package.json") },
    ],
  };
  writeFileSync(reportPath, JSON.stringify(report));
  check("research verify CLI: 5종 전부 실제 검증 통과(exit 0)", () => {
    let code = 0;
    try {
      execFileSync("node", [cli, "research", "verify", "--file", reportPath], { encoding: "utf8" });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 0);
  });

  const badReportPath = join(dir, "bad-report.json");
  writeFileSync(badReportPath, JSON.stringify({
    query: "Phase4 e2e 날조",
    claims: [{ statement: "지어낸 커밋", statedCommit: "0".repeat(40), repoDir: dir }],
  }));
  check("research verify CLI: 존재하지 않는 커밋 주장 → exit 1(진짜 CI 게이트)", () => {
    let code = 0;
    try {
      execFileSync("node", [cli, "research", "verify", "--file", badReportPath], { encoding: "utf8" });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 1);
  });

  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) { console.error(`research-verify: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`research-verify: ${pass} pass ✅`);
