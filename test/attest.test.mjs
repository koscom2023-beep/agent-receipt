// attest in-toto Statement v1 — 형태/subject digest/조건부 byte-invariance/정직 라벨 검증.
// `node test/attest.test.mjs`. Stage 0(6차 council): buildAiWorkStatement 순수함수 잠금.
import assert from "node:assert/strict";
import { buildAiWorkStatement } from "../dist/attest.js";

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

// 최소 Receipt(buildAiWorkStatement 가 읽는 필드만).
const base = {
  schemaVersion: "1.0",
  ok: true,
  contractId: "C-1",
  headHash: "abc1234def",
  timestamp: "2026-01-01T00:00:00.000Z",
  branch: { current: "main", expected: null, ok: true },
  touched: ["a.ts"],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  violations: [],
  checks: [{ name: "build", ok: true }],
  magnitude: { filesChanged: 1, added: 2, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  environment: { agentReceiptVersion: "0.10.0" },
  contentHash: "sha256:deadbeef",
};

check("in-toto Statement v1 _type", () => {
  assert.equal(buildAiWorkStatement(base, 0)._type, "https://in-toto.io/Statement/v1");
});
check("subject digest = receipt sha256 + git commit", () => {
  const s = buildAiWorkStatement(base, 0);
  assert.equal(s.subject[0].digest.sha256, "deadbeef", "receipt sha256 미일치(sha256: 접두 제거)");
  assert.equal(s.subject[1].digest.gitCommit, "abc1234def", "git commit digest 미일치");
});
check("predicateType 보존(발명 금지)", () => {
  assert.ok(buildAiWorkStatement(base, 0).predicateType.includes("agent-receipt/ai-work"), "predicateType 표류");
});
check("정직 라벨 — SLSA 주장 아님 보존", () => {
  assert.ok(String(buildAiWorkStatement(base, 0).predicate.note).includes("SLSA level 주장이 아니"), "정직 라벨 누락");
});
check("capture 없으면 actions 키 부재(byte-invariant — s6-15 골든 보존)", () => {
  const p = buildAiWorkStatement(base, 0).predicate;
  assert.ok(!("actions" in p), "capture 없는데 actions 키 존재 → 골든 깨짐");
  assert.ok(!("actionsSummary" in p), "capture 없는데 actionsSummary 키 존재");
});
check("capture 있으면 actions/actionsSummary 봉인(우리 고유가치)", () => {
  const withAct = {
    ...base,
    actions: [{ tool: "Read", op: "read", path: ".env", flag: "READ_SECRET_FILE" }],
    actionsSummary: { total: 1, secretFilesRead: 1, externalCalls: 0, createdThenDeleted: 0, gitVisible: 0 },
  };
  const p = buildAiWorkStatement(withAct, 0).predicate;
  assert.ok(Array.isArray(p.actions) && p.actions.length === 1, "actions 미포함");
  assert.equal(p.actions[0].flag, "READ_SECRET_FILE");
  assert.equal(p.actionsSummary.secretFilesRead, 1);
});
check("approvals 반영", () => {
  assert.equal(buildAiWorkStatement(base, 3).predicate.approvals, 3);
});

if (fail.length) {
  console.error(`attest: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`attest: ${pass} pass, 0 fail`);
