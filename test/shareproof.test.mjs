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

// ════════ v0.20 결정1·2·3 — 요약 블록(탭 위)·계약 자연어 병기·세션 타임라인 ════════
check("요약 블록 — 수치가 Receipt 필드와 일치(사실-드리프트 차단)", () => {
  const rr = {
    ...r,
    verdict: { verdict: "PASS_WITH_WARNINGS", reasons: ["[critical-path] 고위험 경로 변경: src/pay/**"] },
    contractSnapshot: {
      contractId: "demo", kind: "implementation", allowedGlobs: 2,
      deniedGlobs: [".env*", "secrets/**"], forbiddenActions: ["push"], budget: null, contractHash: "sha256:x",
    },
  };
  const h = toProofHtml(rr);
  assert.ok(h.indexOf('class="exec"') < h.indexOf('class="tabs"'), "요약이 탭 위에 고정");
  assert.ok(h.includes("Changed: <strong>1</strong> file(s) (+2 / -0 lines, 0 new)"), "변경 규모 = magnitude 그대로");
  assert.ok(h.includes("Guard-denied events: <strong>0</strong>"), "가드 거부 기록 N(사실·capture 있을 때)");
  assert.ok(h.includes("이번 세션은 구현 작업으로 계약되었습니다") && h.includes(".env*"), "계약 자연어 ko + denied 전수");
  assert.ok(h.includes("This session was contracted as implementation work"), "계약 자연어 en 병기");
  assert.ok(h.includes("[critical-path]"), "신호 = 판정 사실 재배치(rule-id 그대로)");
  assert.ok(h.includes("not a judgment"), "판단 아님 명시");
  assert.ok(!/권장|추천/.test(h), "권장 어휘 금지(점수화 뒷문 차단)");
});
check("타임라인 — capture 원천 + 접힘 명시(인쇄 포함) 결정론", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`, label: `write f${i}.ts` }));
  const h = toProofHtml(r, null, { timeline: { source: "capture", events: mk(3), folded: 7 } });
  assert.ok(h.includes("Session timeline (captured actions)"), "capture 라벨");
  assert.ok(h.includes("write f2.ts"), "이벤트 렌더");
  assert.ok(h.includes("+ 7 earlier event(s) folded") && h.includes("not hidden"), "접힘 명시(숨김 아님)");
  const h2 = toProofHtml(r, null, { timeline: { source: "capture", events: mk(3), folded: 7 } });
  assert.equal(h, h2, "같은 타임라인 → 같은 HTML(결정론)");
});
check("타임라인 — git 축약판 정직 라벨(capture 미설치)", () => {
  const h = toProofHtml(r, null, { timeline: { source: "git", events: [{ ts: "2026-01-01T00:00:00Z", label: "commit abc — init" }], folded: 0 } });
  assert.ok(h.includes("git commit times") && h.includes("capture hooks are installed"), "축약판 사유 명시");
});
check("타임라인 없음/요약 후에도 script 0·외부 URL 0 불변", () => {
  const h = toProofHtml(r, null, { timeline: null });
  assert.ok(!h.includes("<script") && !h.includes("http://") && !h.includes("https://"), "보안 불변");
});

if (fail.length) {
  console.error(`shareproof: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`shareproof: ${pass} pass, 0 fail`);
