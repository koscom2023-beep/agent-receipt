// P0 v0.17 — 세션 판정(D1)·계약 스냅샷(D2)·사람말 라벨(D3) 테스트.
// 핵심 수용기준(council): 4값 결정론·FAIL>INCOMPLETE>WARN>PASS 우선순위·reasons 로 뒷받침·
//   숫자 점수/등급평균 0·receiptHash 바이트불변(verdict/contractSnapshot=metadata)·라벨=병기.
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

// ── 바이트불변: verdict/contractSnapshot 은 receiptHash 입력 제외(metadata) ──
const rec = {
  headHash: "h1",
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
assert.equal(h1, h2, "verdict/contractSnapshot 부착해도 contentHash 불변");

// ── D3: 사람말 라벨 = 병기(대체 아님) ──
assert.equal(gradeHumanLabel("A", false), GRADE_LABELS.A);
assert.equal(gradeHumanLabel(null, true), ABSTAIN_LABEL);
assert.equal(gradeHumanLabel(null, false), "");
assert.equal(GRADE_LABELS.A, "Strong (recomputed)");
assert.equal(GRADE_LABELS.B, "Source-matched");
assert.equal(GRADE_LABELS.C, "Format-only");

console.log("verdict.test: OK — 4값 게이트(FAIL>INCOMPLETE>WARN>PASS)·reasons 뒷받침·점수0·hash 바이트불변·계약 스냅샷·라벨 병기");
