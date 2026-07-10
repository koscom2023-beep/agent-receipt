// council verify — 결정(decision)의 근거 주장을 인용 커널로 대조 + append-only DecisionLog 해시체인.
// `node test/council-verify.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeDecision, appendDecisionLog } from "../dist/council.js";
import { jcsCanonicalize } from "../dist/jcs.js";

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// ── gradeDecision: grounded / ungrounded / unsupported ──
check("grounded: 근거가 출처에 실재", () => {
  const g = gradeDecision({ statement: "D1", supportingClaims: [{ quotedText: "sky is blue", sourceText: "the sky is blue" }] });
  assert.equal(g.grounding, "grounded"); assert.equal(g.verified, 1); assert.equal(g.notFound, 0);
});
check("ungrounded: 날조 근거 포함", () => {
  const g = gradeDecision({ statement: "D2", supportingClaims: [{ quotedText: "sky is green", sourceText: "the sky is blue" }] });
  assert.equal(g.grounding, "ungrounded"); assert.equal(g.notFound, 1);
});
check("ungrounded: 검증+날조 섞이면 날조가 이김", () => {
  const g = gradeDecision({ statement: "D3", supportingClaims: [
    { quotedText: "real", sourceText: "this is real" },
    { quotedText: "fake", sourceText: "nope" },
  ] });
  assert.equal(g.grounding, "ungrounded"); assert.equal(g.verified, 1); assert.equal(g.notFound, 1);
});
check("unsupported: 근거 없음", () => {
  const g = gradeDecision({ statement: "D4" });
  assert.equal(g.grounding, "unsupported");
});
check("ungrounded: 근거 수치가 재계산과 불일치(수치 커널 재사용)", () => {
  const g = gradeDecision({ statement: "Dn", supportingClaims: [{ statement: "합계 주장", statedValue: 7, op: "sum", operands: [1, 2, 3] }] });
  assert.equal(g.grounding, "ungrounded");
});
check("grounded: 근거 수치가 재계산과 정합", () => {
  const g = gradeDecision({ statement: "Dn2", supportingClaims: [{ statedValue: 6, op: "sum", operands: [1, 2, 3] }] });
  assert.equal(g.grounding, "grounded");
});
check("unsupported: 근거 있으나 출처 없음(전부 no-source)", () => {
  const g = gradeDecision({ statement: "D5", supportingClaims: [{ quotedText: "orphan" }] });
  assert.equal(g.grounding, "unsupported"); assert.equal(g.noSource, 1);
});

// ── appendDecisionLog: 해시체인(prevHash/entryHash) ──
const logPath = join(tmpdir(), `arcouncil-${process.pid}.jsonl`);
if (existsSync(logPath)) rmSync(logPath);
// v0.24 리뷰 #2: entryHash = sha256(prev + JCS(core)). 이전 공식은 JSON.stringify(core, keys.sort())
//   였는데 2번째 인자 배열은 replacer 허용목록이라 중첩 decisions(statement/grounding)를 {}로 떨궈
//   근거를 봉인하지 못했다. 이제 전체를 RFC 8785 JCS 로 정규화해 중첩까지 덮는다.
const expectHash = (prev, core) => createHash("sha256").update(prev + jcsCanonicalize(core)).digest("hex");

check("첫 entry: prevHash 빈값·entryHash 공식 일치", () => {
  const core = { question: "Q1", decisions: [{ statement: "A", grounding: "grounded" }], dissentCount: 0 };
  const r = appendDecisionLog(logPath, core);
  assert.equal(r.prevHash, "");
  assert.equal(r.entryHash, expectHash("", core));
});
check("둘째 entry: prevHash==첫 entryHash(체인 연결)", () => {
  const core2 = { question: "Q2", decisions: [{ statement: "B", grounding: "ungrounded" }], dissentCount: 1 };
  const lines1 = readFileSync(logPath, "utf8").trim().split("\n");
  const first = JSON.parse(lines1[lines1.length - 1]);
  const r2 = appendDecisionLog(logPath, core2);
  assert.equal(r2.prevHash, first.entryHash);
  assert.equal(r2.entryHash, expectHash(first.entryHash, core2));
});
check("리뷰 #2: 중첩 근거(grounding) 변경이 entryHash 를 바꾼다(봉인 커버·과거엔 안 바뀜)", () => {
  const a = { question: "Qx", decisions: [{ statement: "S", grounding: "grounded" }], dissentCount: 0 };
  const b = { question: "Qx", decisions: [{ statement: "S", grounding: "ungrounded" }], dissentCount: 0 };
  assert.notEqual(expectHash("", a), expectHash("", b)); // 옛 replacer-array 공식이면 둘이 같았다(버그)
});
check("파일에 2줄 append됨", () => {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
});
if (existsSync(logPath)) rmSync(logPath);

// ── 감사 fix: gradeDecision 이 근거주장 단위 rich 결과를 반환(영수증→graph 파이프라인 동형) ──
check("gradeDecision.claims: statement/sourceUrl/fingerprint/checks/evidence/verdict + decision 메타", () => {
  const r = gradeDecision({
    id: "D9", statement: "결정문",
    supportingClaims: [{ quotedText: "ghost quote", sourceText: "real text only", sourceUrl: "http://u" }],
  });
  assert.equal(r.grounding, "ungrounded");
  assert.equal(r.claims.length, 1);
  const c = r.claims[0];
  assert.equal(c.statement, "ghost quote"); // statement 부재 → quotedText 대체(발명 금지)
  assert.equal(c.sourceUrl, "http://u");
  assert.ok(c.fingerprint.startsWith("cfp1:")); // graph history/diff 와 같은 키
  assert.equal(c.checks.citation, "not-found");
  assert.ok(c.evidence.citation && c.evidence.citation.expected === "ghost quote"); // 커널 evidence 가 버려지지 않음
  assert.equal(c.verdict, "failed");
  assert.deepEqual([c.decision, c.decisionId], ["결정문", "D9"]);
});
check("gradeDecision.claims: grounded 케이스 verdict=verified·decisionId 없으면 null", () => {
  const r = gradeDecision({ statement: "D", supportingClaims: [{ quotedText: "hello world", sourceText: "say hello world now" }] });
  assert.equal(r.claims[0].verdict, "verified");
  assert.equal(r.claims[0].decisionId, null);
});

// ── Phase4: council 도 git/schema/version 근거를 grounding 판정에 반영하나(실 임시 레포) ──
{
  const dir = mkdtempSync(join(tmpdir(), "arcouncil-e2e-"));
  const git = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "config.ts"), "export const FEATURE_X = true;\n");
  git(["add", "config.ts"]);
  git(["commit", "-q", "-m", "feat: add FEATURE_X"]);
  const realCommit = git(["rev-parse", "HEAD"]).trim();

  check("gradeDecision: 근거가 '이 커밋이 이 파일을 바꿨다'는 실제 git 사실과 일치 → grounded", () => {
    const r = gradeDecision({
      statement: "config 이미 FEATURE_X 지원하므로 이 방식으로 결정",
      supportingClaims: [{ statedCommit: realCommit, statedChangedFile: "config.ts", repoDir: dir }],
    });
    assert.equal(r.grounding, "grounded");
    assert.equal(r.claims[0].checks.fileChanged, "verified");
  });
  check("gradeDecision: 날조된 git 근거(그 커밋이 안 바꾼 파일 주장) → ungrounded", () => {
    const r = gradeDecision({
      statement: "잘못된 근거로 내린 결정",
      supportingClaims: [{ statedCommit: realCommit, statedChangedFile: "never-touched.ts", repoDir: dir }],
    });
    assert.equal(r.grounding, "ungrounded");
    assert.equal(r.claims[0].checks.fileChanged, "not-found");
  });
  check("gradeDecision: 스키마 근거(인라인·IO 불필요)로도 grounded 판정", () => {
    const r = gradeDecision({
      statement: "설정 객체가 이 형태를 만족하므로 채택",
      supportingClaims: [{ schemaData: { enabled: true }, schemaDef: { type: "object", required: ["enabled"] } }],
    });
    assert.equal(r.grounding, "grounded");
  });

  rmSync(dir, { recursive: true, force: true });
}

if (fail.length) { console.error(`council-verify: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`council-verify: ${pass} pass ✅`);
