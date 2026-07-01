// council verify — 결정(decision)의 근거 주장을 인용 커널로 대조 + append-only DecisionLog 해시체인.
// `node test/council-verify.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeDecision, appendDecisionLog } from "../dist/council.js";

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
check("unsupported: 근거 있으나 출처 없음(전부 no-source)", () => {
  const g = gradeDecision({ statement: "D5", supportingClaims: [{ quotedText: "orphan" }] });
  assert.equal(g.grounding, "unsupported"); assert.equal(g.noSource, 1);
});

// ── appendDecisionLog: 해시체인(prevHash/entryHash) ──
const logPath = join(tmpdir(), `arcouncil-${process.pid}.jsonl`);
if (existsSync(logPath)) rmSync(logPath);
const expectHash = (prev, core) => createHash("sha256").update(prev + JSON.stringify(core, Object.keys(core).sort())).digest("hex");

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
check("파일에 2줄 append됨", () => {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
});
if (existsSync(logPath)) rmSync(logPath);

if (fail.length) { console.error(`council-verify: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`council-verify: ${pass} pass ✅`);
