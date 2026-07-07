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
check("--client 축약판(배치A-3) — 동일 증빙 연결 슬롯 + 생략 목록 + 상세 생략", () => {
  const h = toProofHtml(r, null, { client: true, timeline: { source: "git", events: [{ ts: "2026-01-01T00:00:00Z", label: "commit abc — init" }], folded: 0 } });
  assert.ok(!h.includes("Integrity (contentHash)"), "기술표 생략");
  assert.ok(!h.includes("Beyond-git actions"), "상세 생략");
  assert.ok(h.includes("same sealed evidence"), "별도 문서 아님 명시");
  assert.ok(h.includes("Same evidence (contentHash)") && h.includes("sha256:deadbeef"), "동일 contentHash 슬롯(전체판과 같은 값)");
  assert.ok(h.includes("Full technical proof") && h.includes("--bundle"), "전체판·번들 참조 슬롯");
  assert.ok(h.includes("Omitted in this view") && h.includes("touched-file list") && h.includes("capture coverage"), "생략 목록 명시");
  assert.ok(h.includes('class="exec"') && h.includes("Session timeline"), "요약·타임라인 유지");
  assert.ok(!h.includes("<script"), "script 0 불변");
});
// ════════ 배치A-1 — Review Focus 4버킷(재배치만·집합 보존·cap·빈 버킷 표기) ════════
check("4버킷 — 재그룹 전후 신호 집합 동일(누락/중복 0) + 버킷 배치 정확", () => {
  const reasons = [
    "[denied-path] 금지 경로 변경 1건: .env",
    "[critical-path] 고위험 경로 변경: pay/**",
    "[check-failed] 필수 검사 실패 1건: tsc",
    "[red-flag] 확인 신호 1건: 의존성 추가",
    "[mystery-id] 알 수 없는 신호",
  ];
  const h = toProofHtml({ ...r, verdict: { verdict: "FAIL", reasons } });
  for (const s of reasons) {
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.equal((h.match(new RegExp(escaped, "g")) ?? []).length, 1, `정확히 1회 렌더: ${s}`);
  }
  assert.ok(h.indexOf("Scope") < h.indexOf("[denied-path]"), "Scope 버킷 배치");
  assert.ok(h.includes("계약이 지정한"), "Critical 버킷명=판단 주체 명시(렉시콘 내장 아님)");
  assert.ok(h.indexOf("Validation") < h.indexOf("[check-failed]"), "Validation 배치");
  assert.ok(h.indexOf("Agent behavior") < h.indexOf("[red-flag]"), "Behavior 배치");
});
check("4버킷 — 빈 버킷 '해당 없음' + cap 5 접힘 명시(인쇄 포함)", () => {
  const many = Array.from({ length: 7 }, (_, i) => `[red-flag] 신호 ${i}`);
  const h = toProofHtml({ ...r, verdict: { verdict: "PASS_WITH_WARNINGS", reasons: many } });
  assert.ok(h.includes("Scope") && h.includes("해당 없음"), "빈 버킷 표기(침묵 금지)");
  assert.ok(h.includes("외 2건") && h.includes("인쇄 포함"), "cap 5 + 접힘 명시");
  assert.ok(!/권장|추천/.test(h), "판단어 금지 유지");
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
