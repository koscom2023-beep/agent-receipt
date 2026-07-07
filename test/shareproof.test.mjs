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

// ════════ P2 v0.19 D5 — 3축 탭(CSS-only·script 0 유지) ════════
check("탭 3축(Change/Evidence/Cost) — radio+label+pane 존재", () => {
  for (const id of ["pt-change", "pt-evidence", "pt-cost"]) assert.ok(html.includes(`id="${id}"`), `radio ${id}`);
  for (const cls of ["pane-change", "pane-evidence", "pane-cost"]) assert.ok(html.includes(cls), `pane ${cls}`);
  assert.ok(html.includes('type="radio"'), "CSS-only radio 탭");
  assert.ok(!html.includes("<script"), "탭 도입 후에도 script 0(보안 불변)");
});
check("DA-3: 인쇄=전 패널 펼침 규칙", () => {
  assert.ok(html.includes("@media print") && html.includes("display:block!important"), "print 펼침 규칙");
});
check("빈 탭 정직 표기(침묵 금지) — 포함 방법 안내", () => {
  assert.ok(html.includes("--evidence-dir"), "Evidence 빈 탭에 포함 방법");
  assert.ok(html.includes("--with-cost"), "Cost 빈 탭에 포함 방법");
});
check("extras 주입 — evidence 롤업(중립·판단 없음) + cost 라벨", () => {
  const h = toProofHtml(r, null, {
    evidence: { receipts: 5, pass: 4, fail: 1, exceptions: 2, mostFailedCheck: "citation" },
    evidenceDirLabel: ".agent-guard/vreceipts",
    costLines: ["이 세션 비용(추정·리스트가·청구서 아님): ~$1.23"],
  });
  assert.ok(h.includes("<strong>5</strong>") && h.includes("citation"), "evidence 카운트+최다실패");
  assert.ok(h.includes("not a judgment"), "중립 명시");
  assert.ok(h.includes("~$1.23") && h.includes("Estimate, not an invoice"), "cost 라벨");
  assert.ok(!h.includes("<script"), "extras 주입 후에도 script 0");
});

if (fail.length) {
  console.error(`shareproof: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`shareproof: ${pass} pass, 0 fail`);
