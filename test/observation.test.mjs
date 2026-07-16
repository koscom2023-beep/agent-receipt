// P0-1/P0-2 (정본 2026-07-16): 관찰 배선 진단 + 0 의 네 가지 뜻.
//
// 이 테스트가 박제하는 실측 사실(2026-07-16 전수 분석):
//   · capture 기록이 44일간 실제 0건인데 영수증 308건이 7/3 probe 2줄을 반복 인용하며 PASS 를 찍었다.
//   · promptia 는 측정 창이 7/15 인데 capture 마지막 기록이 7/3 이었다 → "기록 2건"이라 정상으로 보였다.
//     **적은 nonzero 는 0 만큼이나 죽어 있다.** 창 밖 잔재를 수신으로 세면 죽은 훅이 살아 보인다.
import assert from "node:assert";
import { assessObservation, detectWiring, zeroMeaning, ZERO_MEANING_TEXT } from "../dist/observation.js";
import { sessionVerdict, observationIncomplete } from "../dist/verdict.js";

const SITE = [{ path: ".claude/settings.json", events: ["PreToolUse", "PostToolUse"] }];
const rec = (ts, op = "write", path = "a.ts") => ({ ts, phase: "post", tool: "Write", op, path, sessionId: "s1" });
const assess = (o) => assessObservation({ sites: [], logExists: true, records: [], chainProblems: 0, truncated: false, windowStart: null, ...o });

// ── 배선 감지: install 이 심는 command 접두를 그대로 본다(단일 원천) ──
assert.deepEqual(detectWiring(null), [], "settings 없음 = 배선 없음");
assert.deepEqual(detectWiring({}), [], "hooks 없음 = 배선 없음");
assert.deepEqual(detectWiring({ hooks: { PreToolUse: [{ hooks: [{ command: "other-tool" }] }] } }), [], "남의 훅은 우리 배선 아님");
assert.deepEqual(
  detectWiring({ hooks: { PreToolUse: [{ hooks: [{ command: "agent-receipt capture --event pre" }] }] } }),
  ["PreToolUse"],
  "우리 capture 훅 감지",
);

// ── not-wired: 훅을 안 깐 git 전용 사용자는 정상이다. INCOMPLETE 로 내리지 않는다(트리거 정확성) ──
let h = assess({ sites: [], records: [] });
assert.equal(h.verdict, "not-wired");
assert.equal(observationIncomplete(h), null, "미배선은 INCOMPLETE 가 아니다. git 전용 사용자는 정상 상태");
assert.match(h.text, /git 변경 한정/, "다만 관찰 범위는 반드시 공시한다(과대 주장 금지)");

// ── wired-silent: 배선했는데 기록 0 = 진짜 고장 ──
h = assess({ sites: SITE, records: [] });
assert.equal(h.verdict, "wired-silent");
assert.equal(observationIncomplete(h).code, "observation-silent");
assert.ok(h.fix, "고장이면 고치는 법을 반드시 낸다");

// ── 🔴 진범 박제: 창 밖 잔재는 수신이 아니다 ──
// promptia 실측 재현. 창은 7/15 인데 기록은 7/3 두 건이었다. 예전 코드는 "기록 2건이니 정상"이라 했다.
h = assess({ sites: SITE, records: [rec("2026-07-03T09:04:42.901Z"), rec("2026-07-03T09:05:00.000Z")], windowStart: "2026-07-15T14:30:40.156Z" });
assert.equal(h.actions, 0, "창 밖 기록은 이번 세션 관찰이 아니다");
assert.equal(h.stale, 2, "창 밖 잔재는 숨기지 않고 센다");
assert.equal(h.verdict, "wired-silent", "적은 nonzero 도 창 밖이면 죽은 것. 여기가 2026-07-16 실측 진범");
assert.match(h.text, /잔재 2건/, "잔재 사실을 사람에게 말한다");

// 창 안 기록이 있으면 정상.
h = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")], windowStart: "2026-07-15T14:30:40.156Z" });
assert.equal(h.verdict, "observed");
assert.equal(h.actions, 1);
assert.equal(h.stale, 0);
assert.equal(observationIncomplete(h), null);

// 창이 없으면 전체를 창으로 본다(하위호환. begin 안 쓰는 사용자).
h = assess({ sites: SITE, records: [rec("2026-07-03T09:04:42.901Z")], windowStart: null });
assert.equal(h.verdict, "observed", "창 없음 = 전체가 창");

// 깨진 ts 는 창 안으로 본다(못 읽는다고 증거를 버리지 않는다).
h = assess({ sites: SITE, records: [rec("not-a-date")], windowStart: "2026-07-15T14:30:40.156Z" });
assert.equal(h.actions, 1, "파싱 실패 ts 는 창 안으로 본다. 증거를 조용히 버리지 않는다");

// ── degraded: 열화 마커 / 체인 문제 / 꼬리 잘림 ──
h = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z"), { ts: "2026-07-16T01:00:01.000Z", phase: "post", tool: "(capture)", op: "capture-degraded", reason: "stdin 파싱 실패" }] });
assert.equal(h.verdict, "degraded", "열화 마커가 있으면 숫자를 믿을 수 없다");
assert.equal(h.degraded, 1);
assert.equal(h.actions, 1, "열화 마커는 행동으로 세지 않는다");
assert.equal(observationIncomplete(h).code, "observation-degraded");

h = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")], chainProblems: 1 });
assert.equal(h.verdict, "degraded", "체인 문제 = 손상");
h = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")], truncated: true });
assert.equal(h.verdict, "degraded", "꼬리 잘림 = 손상");

// ── P0-2: 0 은 네 가지 뜻이 있다. 넷을 구분 못 하는 계기의 0 은 거짓말이다 ──
assert.equal(zeroMeaning(assess({ sites: SITE, records: [] })), "recorder-off", "배선했는데 0 = 못 봤다");
assert.equal(zeroMeaning(assess({ sites: [], records: [] })), "recorder-off", "미배선도 못 본 것");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z"), { ts: "x", phase: "post", tool: "(capture)", op: "capture-degraded" }] })), "corrupted");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")] }), false), "no-input", "입력이 없으면 대조 미실행이지 0 이 아니다");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")] }), true), "no-activity", "기록기 정상 + 입력 있음 = 진짜 없었음");
for (const k of ["no-activity", "recorder-off", "no-input", "corrupted"]) assert.ok(ZERO_MEANING_TEXT[k], `${k} 사람말 있음`);

// ── 판정 통합: 관찰이 비면 PASS 를 안 찍는다 ──
const base = {
  ok: true,
  deniedHits: [],
  outOfScope: [],
  checks: [{ name: "tsc", exitCode: 0, requiredExit: 0, ok: true }],
  criticalPaths: [],
  session: { applied: true, reason: null, baselineHead: "abc123" },
  violations: [],
  policy: { forbidAlwaysHits: [] },
};
assert.equal(sessionVerdict(base).verdict, "PASS", "관찰 미제공 = 기존 호출자 판정 불변(하위호환)");
assert.equal(sessionVerdict(base, { observation: assess({ sites: [], records: [] }) }).verdict, "PASS", "미배선은 PASS 유지");
assert.equal(sessionVerdict(base, { observation: assess({ sites: SITE, records: [] }) }).verdict, "INCOMPLETE", "🔑 배선했는데 관찰 0 이면 PASS 금지");
assert.equal(sessionVerdict(base, { observation: assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")] }) }).verdict, "PASS", "관찰 정상이면 PASS");

// FAIL 이 관찰보다 세다(우선순위 불변).
assert.equal(sessionVerdict({ ...base, ok: false, deniedHits: ["x"] }, { observation: assess({ sites: SITE, records: [] }) }).verdict, "FAIL");

// 두 축(측정 창 + 관찰)이 동시에 불완전하면 사유를 둘 다 낸다.
const both = sessionVerdict({ ...base, session: null }, { observation: assess({ sites: SITE, records: [] }) });
assert.equal(both.verdict, "INCOMPLETE");
assert.equal(both.reasons.length, 2, "baseline 과 observation 은 다른 축이므로 둘 다 낸다");
assert.ok(both.reasons.some((r) => r.includes("[no-baseline]")));
assert.ok(both.reasons.some((r) => r.includes("[observation-silent]")));

console.log("observation.test.mjs OK");
