// P0 v0.17 — 세션 판정(D1)·계약 스냅샷(D2)·사람말 라벨(D3) 테스트.
// 핵심 수용기준(council): 4값 결정론·FAIL>INCOMPLETE>WARN>PASS 우선순위·reasons 로 뒷받침·
//   숫자 점수/등급평균 0·receiptHash 가 판정(ok/verdict/contractSnapshot)을 봉인(리뷰 #1)·라벨=병기.
import assert from "node:assert";
import { sessionVerdict, buildContractSnapshot, renderVerdictLine, renderContractLine, VERDICT_MARK } from "../dist/verdict.js";
import { receiptHash } from "../dist/receipt.js";
import { gradeHumanLabel, GRADE_LABELS, ABSTAIN_LABEL } from "../dist/evidencekernel.js";

const okSession = { applied: true, reason: null, baselineHead: "abc123", kind: "implementation" };
const base = {
  ok: true,
  deniedHits: [],
  outOfScope: [],
  checks: [{ name: "tsc", exitCode: 0, requiredExit: 0, ok: true }],
  criticalPaths: [],
  session: okSession,
  violations: [],
  policy: { forbidAlwaysHits: [] },
};

// ── D1: 4값 + 우선순위 ──
// PASS
let v = sessionVerdict(base);
assert.equal(v.verdict, "PASS");
assert.ok(v.reasons.length >= 1, "PASS 도 reasons 로 뒷받침");

// FAIL — denied + 실패검사(사실 나열)
v = sessionVerdict({ ...base, ok: false, deniedHits: [".env"], checks: [{ name: "tsc", ok: false }] });
assert.equal(v.verdict, "FAIL");
assert.ok(v.reasons.some((r) => r.includes(".env")), "금지경로 사실");
assert.ok(v.reasons.some((r) => r.includes("tsc")), "실패 검사 사실");

// FAIL 이 INCOMPLETE 보다 우선(위반은 baseline 없어도 실재 — denied 는 full-tree 검사)
v = sessionVerdict({ ...base, ok: false, deniedHits: [".env"], session: null });
assert.equal(v.verdict, "FAIL", "FAIL > INCOMPLETE");

// INCOMPLETE — baseline 없음 / stale (정의 고정)
v = sessionVerdict({ ...base, session: null });
assert.equal(v.verdict, "INCOMPLETE");
assert.ok(v.reasons[0].includes("baseline 없음"));
v = sessionVerdict({ ...base, session: { applied: false, reason: "branch switched", baselineHead: "x" } });
assert.equal(v.verdict, "INCOMPLETE");
assert.ok(v.reasons[0].includes("stale"));

// PASS_WITH_WARNINGS — critical/policy/waste/redflag
v = sessionVerdict({ ...base, criticalPaths: [{ glob: "src/payments/**", touched: ["src/payments/a.ts"] }] });
assert.equal(v.verdict, "PASS_WITH_WARNINGS");
v = sessionVerdict({ ...base, policy: { forbidAlwaysHits: ["supabase/migrations/x.sql"] } });
assert.equal(v.verdict, "PASS_WITH_WARNINGS");
v = sessionVerdict(base, { wasteSignal: true });
assert.equal(v.verdict, "PASS_WITH_WARNINGS");
v = sessionVerdict(base, { redFlags: ["test .only 발견"] });
assert.equal(v.verdict, "PASS_WITH_WARNINGS");
assert.ok(v.reasons.some((r) => r.includes("확인 신호")));

// 결정론: 같은 입력 → 같은 결과
assert.deepEqual(sessionVerdict(base, { wasteSignal: true }), sessionVerdict(base, { wasteSignal: true }));

// ── 점수 금지(게이트 문구 + 숫자점수 정규식 0) ──
const rendered = [
  renderVerdictLine(sessionVerdict(base)),
  renderVerdictLine(sessionVerdict({ ...base, ok: false, deniedHits: [".env"] })),
].join("\n");
assert.ok(rendered.includes("점수 아님"), "게이트 라벨 명시");
assert.ok(!/\/\s*100|\b\d+\s*점\b|score|grade\s*avg/i.test(rendered), "숫자 점수/등급평균 없음");
for (const k of Object.keys(VERDICT_MARK)) assert.ok(["PASS", "PASS_WITH_WARNINGS", "FAIL", "INCOMPLETE"].includes(k));

// ── D2: 계약 스냅샷(최소필드+hash 포인터) + 렌더 ──
const contract = {
  scope: { allowed_paths: ["src/**", "test/**"], denied_paths: [".env*", "package.json"] },
  forbidden_actions: ["push", "deploy"],
  budget: { max_touched_files: 30 },
};
const snap = buildContractSnapshot(contract, {
  contractId: "demo",
  session: okSession,
  environment: { contractHash: "sha256:cafe" },
});
assert.equal(snap.kind, "implementation");
assert.equal(snap.allowedGlobs, 2, "allowed 는 개수(비대 방지)");
assert.deepEqual(snap.deniedGlobs, [".env*", "package.json"], "denied 는 목록(위험표면)");
assert.deepEqual(snap.forbiddenActions, ["push", "deploy"]);
assert.equal(snap.budget.maxTouchedFiles, 30);
assert.equal(snap.contractHash, "sha256:cafe");
const cline = renderContractLine(snap);
assert.ok(cline.includes("kind=implementation") && cline.includes(".env*") && cline.includes("advisory"), "계약 1줄 렌더");

// budget/kind 없음 → null 처리
const snap2 = buildContractSnapshot({ scope: { allowed_paths: [], denied_paths: [] }, forbidden_actions: [] }, { contractId: "d", session: null, environment: {} });
assert.equal(snap2.kind, null);
assert.equal(snap2.budget, null);

// ── v0.24 리뷰 #1: 판정(ok/verdict/contractSnapshot)은 이제 receiptHash 에 봉인된다(위변조 차단) ──
const rec = {
  headHash: "h1",
  ok: false,
  violations: ["x"],
  branch: { current: "main", expected: "main", ok: true },
  contractId: "c1",
  touched: ["a.ts"],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  magnitude: { filesChanged: 1 },
  criticalPaths: [],
  checks: [{ name: "tsc", exitCode: 0, requiredExit: 0, ok: true }],
};
const h1 = receiptHash(rec);
const h2 = receiptHash({ ...rec, verdict: sessionVerdict(base), contractSnapshot: snap });
assert.notEqual(h1, h2, "verdict/contractSnapshot 부착이 봉인을 바꾼다. 판정 위변조 차단(과거엔 metadata 라 불변=버그)");
// 핵심 공격 차단: ok 를 FAIL→PASS 로 뒤집으면 봉인이 바뀐다(shareproof 히어로가 읽는 값).
assert.notEqual(receiptHash(rec), receiptHash({ ...rec, ok: true }), "ok 위변조가 contentHash 를 바꾼다");
assert.notEqual(receiptHash(rec), receiptHash({ ...rec, violations: [] }), "violations 위변조가 contentHash 를 바꾼다");

// ── D3: 사람말 라벨 = 병기(대체 아님) ──
assert.equal(gradeHumanLabel("A", false), GRADE_LABELS.A);
assert.equal(gradeHumanLabel(null, true), ABSTAIN_LABEL);
assert.equal(gradeHumanLabel(null, false), "");
assert.equal(GRADE_LABELS.A, "Strong (recomputed)");
assert.equal(GRADE_LABELS.B, "Source-matched");
assert.equal(GRADE_LABELS.C, "Format-only");

// ════════ P1 v0.18 — D1 규칙 레지스트리 · D2 INCOMPLETE 세분 · D3 fail_on_done 임계 ════════
import { readFileSync } from "node:fs";
import { VERDICT_RULES, WARN_ESCALATION_NOTE, incompleteDetail, VERDICT_SEVERITY, failOnDoneTriggers } from "../dist/verdict.js";

// D1: 레지스트리 — id 유일·4값 커버·WARN 4종
const ids = VERDICT_RULES.map((r) => r.id);
assert.equal(new Set(ids).size, ids.length, "rule id 유일");
assert.equal(VERDICT_RULES.filter((r) => r.verdict === "PASS_WITH_WARNINGS").length, 4, "WARN 규칙 4종");
assert.equal(VERDICT_RULES.filter((r) => r.verdict === "INCOMPLETE").length, 4, "INCOMPLETE 코드 4종");
assert.ok(WARN_ESCALATION_NOTE.includes("자동 승격되지 않는다"), "승격 없음 명문");

// D1: reason 은 [rule-id] 형식(기계 판독) — 발동한 규칙 id 가 레지스트리에 실재
v = sessionVerdict({ ...base, ok: false, deniedHits: [".env"] });
assert.ok(v.reasons[0].startsWith("[denied-path]"), "FAIL reason 에 rule id");
v = sessionVerdict({ ...base, criticalPaths: [{ glob: "src/pay/**", touched: ["src/pay/a.ts"] }] });
assert.ok(v.reasons[0].startsWith("[critical-path]"), "WARN reason 에 rule id");
for (const reason of v.reasons) {
  const m = reason.match(/^\[([a-z-]+)\]/);
  assert.ok(m && ids.includes(m[1]), `reason 의 id 가 레지스트리에 실재: ${reason}`);
}

// D2: INCOMPLETE 코드 + 고치는 법(고정 매핑)
let d = incompleteDetail(null);
assert.equal(d.code, "no-baseline");
assert.ok(d.fix.includes("begin"), "no-baseline fix 는 begin 안내");
d = incompleteDetail({ applied: false, reason: "branch-mismatch", baselineHead: "x" });
assert.equal(d.code, "stale-branch-mismatch");
d = incompleteDetail({ applied: false, reason: "baseline-not-ancestor", baselineHead: "x" });
assert.equal(d.code, "stale-baseline-not-ancestor");
assert.ok(d.text.includes("rebase"), "not-ancestor 는 rebase/reset 흔적 설명");
d = incompleteDetail({ applied: false, reason: null, baselineHead: "x" });
assert.equal(d.code, "stale-unknown");
assert.equal(incompleteDetail(okSession), null, "applied=true 면 null");
v = sessionVerdict({ ...base, session: null });
assert.ok(v.reasons[0].startsWith("[no-baseline]") && v.reasons[0].includes("고치는 법"), "INCOMPLETE reason = [code]+fix 병기");

// D3: 임계 매트릭스(순수·결정론)
assert.equal(VERDICT_SEVERITY.FAIL, 3);
assert.equal(failOnDoneTriggers("PASS", "warn"), false);
assert.equal(failOnDoneTriggers("PASS_WITH_WARNINGS", "warn"), true);
assert.equal(failOnDoneTriggers("PASS_WITH_WARNINGS", "incomplete"), false);
assert.equal(failOnDoneTriggers("INCOMPLETE", "incomplete"), true);
assert.equal(failOnDoneTriggers("INCOMPLETE", "fail"), false);
assert.equal(failOnDoneTriggers("FAIL", "fail"), true);
assert.equal(failOnDoneTriggers("FAIL", "warn"), true);

// D1: docs/VERDICT.md ↔ 레지스트리 id 일치(표류 방지 — 문서가 코드 표의 서술)
const doc = readFileSync(new URL("../docs/VERDICT.md", import.meta.url), "utf8");
for (const id of ids) assert.ok(doc.includes(`\`${id}\``), `docs/VERDICT.md 에 rule id 누락: ${id}`);
assert.ok(doc.includes("자동 승격되지 않는다"), "docs 에 승격 없음 명문");
assert.ok(doc.includes("fail_on_done"), "docs 에 fail_on_done 표");

// ════════ v0.20 결정2 — 계약 자연어화(고정 템플릿·한/영·결정론) ════════
import { renderContractProse } from "../dist/verdict.js";
const prose = renderContractProse(snap);
assert.deepEqual(prose, renderContractProse(snap), "같은 계약 → 같은 문장(결정론)");
for (const d2 of snap.deniedGlobs) {
  assert.ok(prose.ko.includes(d2) && prose.en.includes(d2), `denied 전수 포함: ${d2}`);
}
assert.ok(prose.ko.includes("구현") && prose.en.includes("implementation"), "kind 한/영 매핑");
assert.ok(prose.ko.includes("기계 강제 아님") && prose.en.includes("advisory"), "advisory 정직 라벨");
assert.ok(prose.ko.includes("30개 이하") && prose.en.includes("≤30"), "budget 문장");
const prose2 = renderContractProse(snap2);
assert.ok(prose2.ko.includes("금지 경로는 지정되지 않았습니다") && prose2.en.includes("No denied paths"), "빈 계약 정직 문장");
assert.ok(!/권장|추천/.test(prose.ko + prose2.ko), "권장 어휘 금지");

console.log("verdict.test: OK — 4값 게이트·reasons 뒷받침·점수0·판정 봉인(리뷰#1)·계약 스냅샷·라벨 병기 + P1(규칙 레지스트리·[id] reason·INCOMPLETE 세분+fix·fail_on_done 임계·docs 일치) + v0.20(계약 자연어 결정론·denied 전수·한영)");
