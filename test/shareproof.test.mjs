// share-proof v0 (council B) — toProofHtml 순수함수 검증. `node test/shareproof.test.mjs`.
// 정직 라벨 + HTML injection esc + network 0(외부 리소스 없음) + git⟷행위 대비.
import assert from "node:assert/strict";
import { toProofHtml } from "../dist/shareproof.js";

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

// 최소 Receipt(toProofHtml 이 쓰는 필드만) — contractId 에 주입 시도 포함.
const r = {
  schemaVersion: "1.0",
  ok: true,
  contractId: "<script>alert(1)</script>",
  title: null,
  branch: { current: "main", expected: null, ok: true },
  headHash: "abc1234",
  timestamp: "2026-01-01T00:00:00.000Z",
  touched: ["a.ts"],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  violations: [],
  session: null,
  checks: [{ name: "build", exitCode: 0, requiredExit: 0, ok: true }],
  magnitude: { filesChanged: 1, added: 2, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  policy: null,
  environment: {},
  disclosure: "x",
  actions: [
    { tool: "Read", op: "read", path: ".env", flag: "READ_SECRET_FILE" },
    { tool: "Bash", op: "network", host: "api.example", flag: "EXTERNAL_NETWORK_CALL" },
  ],
  actionsSummary: { total: 2, secretFilesRead: 1, externalCalls: 1, createdThenDeleted: 0, gitVisible: 0 },
  contentHash: "sha256:deadbeef",
};

const html = toProofHtml(r);

check("PASS 표시", () => assert.ok(html.includes("PASS")));
check("contentHash 포함", () => assert.ok(html.includes("sha256:deadbeef")));
check("HTML injection esc — 주입문자 이스케이프", () => {
  assert.ok(html.includes("&lt;script&gt;"), "contractId 미이스케이프");
  assert.ok(!html.includes("<script"), "<script 원문 존재(주입/스크립트태그)");
});
check("network 0 — 외부 리소스 없음", () => {
  assert.ok(!html.includes("http://") && !html.includes("https://"), "외부 URL 존재");
  assert.ok(!html.includes("src="), "src= 존재(외부 로드 위험)");
});
check("git⟷행위 대비", () => {
  assert.ok(html.includes("git saw: 0"), "gitVisible 미표시");
  assert.ok(html.includes("actions recorded: 2"), "actions total 미표시");
});
check("정직 라벨 — 과장 금지", () => {
  assert.ok(html.includes("tamper-evident"), "tamper-evident 누락");
  assert.ok(html.includes("not a compliance guarantee"), "컴플라이언스 보장 아님 누락");
  assert.ok(html.includes("AI Work Receipt"), "제목 receipt 누락");
});
check("FAIL 경로도 렌더(ok=false)", () => {
  const f = toProofHtml({ ...r, ok: false });
  assert.ok(f.includes("FAIL"));
});
check("actions 없으면 beyond-git 섹션 생략(바이트 절약)", () => {
  const noAct = { ...r };
  delete noAct.actions;
  delete noAct.actionsSummary;
  const h = toProofHtml(noAct);
  assert.ok(!h.includes("Beyond-git actions"));
});

if (fail.length) {
  console.error(`shareproof: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`shareproof: ${pass} pass, 0 fail`);
