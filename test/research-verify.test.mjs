// research 인용검증 커널 — quotedText 가 출처의 리터럴 부분문자열인지 결정론 대조(비-LLM).
// `node test/research-verify.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
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

// ── Phase5: Markdown 어댑터 — 동결 문법 파싱 + JSON 동형성(같은 내용→같은 판정) ──
{
  const dir = mkdtempSync(join(tmpdir(), "armd-"));
  writeFileSync(join(dir, "src.txt"), "the total was 42 items on 2026-07-01");
  const mdBody = `# md 동형성 검증

- statement: 합계 주장
  quotedText: "the total was 42 items"
  sourceFile: ${join(dir, "src.txt")}
  statedValue: 42

- statement: 날조 주장
  quotedText: "totally fabricated sentence"
  sourceFile: ${join(dir, "src.txt")}
`;
  const jsonBody = {
    query: "md 동형성 검증",
    claims: [
      { statement: "합계 주장", quotedText: "the total was 42 items", sourceFile: join(dir, "src.txt"), statedValue: 42 },
      { statement: "날조 주장", quotedText: "totally fabricated sentence", sourceFile: join(dir, "src.txt") },
    ],
  };
  const mdPath = join(dir, "r.md");
  const jsonPath = join(dir, "r.json");
  writeFileSync(mdPath, mdBody);
  writeFileSync(jsonPath, JSON.stringify(jsonBody));
  const runCli = (file, out) => {
    let code = 0, stdout = "";
    try {
      stdout = execFileSync("node", [cli, "research", "verify", "--file", file, "--out", out], { encoding: "utf8" });
    } catch (e) {
      code = e.status ?? 1;
      stdout = String(e.stdout ?? "");
    }
    return { code, stdout };
  };
  const rMd = runCli(mdPath, join(dir, "out-md.json"));
  const rJs = runCli(jsonPath, join(dir, "out-js.json"));
  check("md 어댑터: 동일 내용 md↔JSON → exit 코드 동일(둘 다 1 — 날조 1건)", () => {
    assert.equal(rMd.code, 1);
    assert.equal(rJs.code, 1);
  });
  check("md 어댑터: 영수증 results 의 verdict/checks 완전 동일(동형성)", () => {
    const a = JSON.parse(readFileSync(join(dir, "out-md.json"), "utf8"));
    const b = JSON.parse(readFileSync(join(dir, "out-js.json"), "utf8"));
    const slim = (r) => r.results.map((x) => ({ s: x.statement, v: x.verdict, c: x.checks }));
    assert.deepEqual(slim(a), slim(b));
  });
  check("md 어댑터: 주장 0건 md → exit 2(조용한 빈 결과 금지)", () => {
    const emptyPath = join(dir, "empty.md");
    writeFileSync(emptyPath, "# 제목만 있고 주장 없음\n\n그냥 산문.\n");
    let code = 0;
    try {
      execFileSync("node", [cli, "research", "verify", "--file", emptyPath], { encoding: "utf8" });
    } catch (e) {
      code = e.status ?? 1;
    }
    assert.equal(code, 2);
  });
  // ── Phase5: file + receipt 체크 e2e ──
  check("file 체크 e2e: 실재 파일 verified·부재 파일 not-found→exit 1", () => {
    const okReport = join(dir, "file-ok.json");
    writeFileSync(okReport, JSON.stringify({ query: "f", claims: [{ statement: "실재", statedFile: join(dir, "src.txt") }] }));
    assert.equal(runCli(okReport, join(dir, "fo.json")).code, 0);
    const badReport = join(dir, "file-bad.json");
    writeFileSync(badReport, JSON.stringify({ query: "f", claims: [{ statement: "부재", statedFile: join(dir, "ghost.txt") }] }));
    assert.equal(runCli(badReport, join(dir, "fb.json")).code, 1);
  });
  check("artifact 체크 e2e: 크기 제약 충족 exit 0·미달 exit 1(빈/절단 산출물 검출)", () => {
    const artPath = join(dir, "bundle.js");
    writeFileSync(artPath, "x".repeat(300)); // 300B 산출물
    const okR = join(dir, "art-ok.json");
    writeFileSync(okR, JSON.stringify({ query: "a", claims: [{ statement: "번들 정상 크기", statedArtifact: artPath, artifactMinBytes: 100 }] }));
    assert.equal(runCli(okR, join(dir, "ao.json")).code, 0);
    const badR = join(dir, "art-bad.json");
    writeFileSync(badR, JSON.stringify({ query: "a", claims: [{ statement: "번들이 최소 1KB 라는 주장", statedArtifact: artPath, artifactMinBytes: 1024 }] }));
    assert.equal(runCli(badR, join(dir, "ab.json")).code, 1);
    const nbR = join(dir, "art-nb.json");
    writeFileSync(nbR, JSON.stringify({ query: "a", claims: [{ statement: "제약 없는 경로만(no-basis→advisory)", statedArtifact: artPath }] }));
    assert.equal(runCli(nbR, join(dir, "an.json")).code, 0); // no-basis=advisory·게이트 아님
  });
  check("receipt 체크 e2e: 진짜 영수증 인용 verified·변조본 인용 exit 1", () => {
    // out-js.json 은 위에서 CLI 가 실제 봉인한 영수증 — 그 id 를 읽어 인용.
    const vr = JSON.parse(readFileSync(join(dir, "out-js.json"), "utf8"));
    const okReport = join(dir, "rc-ok.json");
    writeFileSync(okReport, JSON.stringify({ query: "rc", claims: [{ statement: "인용 영수증 무결", statedReceiptId: vr.receiptId.slice(0, 12), receiptFile: join(dir, "out-js.json") }] }));
    assert.equal(runCli(okReport, join(dir, "rco.json")).code, 0);
    const tampered = readFileSync(join(dir, "out-js.json"), "utf8").replace('"fail"', '"pass"');
    writeFileSync(join(dir, "vr-t.json"), tampered);
    const badReport = join(dir, "rc-bad.json");
    writeFileSync(badReport, JSON.stringify({ query: "rc", claims: [{ statement: "변조 영수증 인용", statedReceiptId: vr.receiptId.slice(0, 12), receiptFile: join(dir, "vr-t.json") }] }));
    assert.equal(runCli(badReport, join(dir, "rcb.json")).code, 1);
  });
  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) { console.error(`research-verify: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`research-verify: ${pass} pass ✅`);
