// P0-1/P0-2 (정본 2026-07-16): 관찰 배선 진단 + 0 의 네 가지 뜻.
//
// 이 테스트가 박제하는 실측 사실(2026-07-16 전수 분석):
//   · capture 기록이 44일간 실제 0건인데 영수증 308건이 7/3 probe 2줄을 반복 인용하며 PASS 를 찍었다.
//   · promptia 는 측정 창이 7/15 인데 capture 마지막 기록이 7/3 이었다 → "기록 2건"이라 정상으로 보였다.
//     **적은 nonzero 는 0 만큼이나 죽어 있다.** 창 밖 잔재를 수신으로 세면 죽은 훅이 살아 보인다.
import assert from "node:assert";
import { assessObservation, detectWiring, zeroMeaning, ZERO_MEANING_TEXT, OBSERVATION_STATE_CODE, OBSERVATION_CAUSE_TEXT } from "../dist/observation.js";
import { sessionVerdict, observationIncomplete } from "../dist/verdict.js";
import { sessionCreator } from "../dist/session.js";

const SITE = [{ path: ".claude/settings.json", events: ["PreToolUse", "PostToolUse"] }];
const rec = (ts, op = "write", path = "a.ts") => ({ ts, phase: "post", tool: "Write", op, path, sessionId: "s1" });
const recSeq = (seq, ts = "2026-07-16T01:00:00.000Z") => ({ ts, phase: "post", tool: "Write", op: "write", path: "a.ts", sessionId: "s1", seq });
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

// ── UNAVAILABLE: 훅을 안 깐 git 전용 사용자는 정상이다. INCOMPLETE 로 내리지 않는다(트리거 정확성) ──
// 미배선은 기계가 확인한 사실이므로 원인을 확정해도 된다. 여기가 SILENT 와 갈리는 지점이다.
let h = assess({ sites: [], records: [] });
assert.equal(h.verdict, "unavailable");
assert.equal(h.cause, "no-wiring", "기계가 확인한 원인이므로 확정");
assert.equal(observationIncomplete(h), null, "미배선은 INCOMPLETE 가 아니다. git 전용 사용자는 정상 상태");
assert.match(h.text, /git 변경 한정/, "다만 관찰 범위는 반드시 공시한다(과대 주장 금지)");

// ── SILENT: 배선했는데 창 안 기록 0. 못 받은 것은 확정, 원인은 미확정 ──
h = assess({ sites: SITE, records: [] });
assert.equal(h.verdict, "silent");
assert.equal(h.cause, "unknown", "🔑 P0-2 정정: 원인을 단정하지 않는다");
assert.equal(observationIncomplete(h).code, "observation-silent");
assert.ok(h.fix, "고장이면 고치는 법을 반드시 낸다");
// 🔴 회귀 방지: 기계가 증명하지 못한 원인을 단정하면 안 된다(2026-07-16 owner 정정).
assert.doesNotMatch(h.text, /꺼져|미설치|승인 대기/, "SILENT 에서 원인 단정 금지. 확정한 것은 '못 받았다' 뿐이다");
assert.match(h.text, /미확정/, "원인이 미확정이라는 사실 자체를 말한다");

// ── 🔴 진범 박제: 창 밖 잔재는 수신이 아니다 ──
// promptia 실측 재현. 창은 7/15 인데 기록은 7/3 두 건이었다. 예전 코드는 "기록 2건이니 정상"이라 했다.
h = assess({ sites: SITE, records: [rec("2026-07-03T09:04:42.901Z"), rec("2026-07-03T09:05:00.000Z")], windowStart: "2026-07-15T14:30:40.156Z" });
assert.equal(h.actions, 0, "창 밖 기록은 이번 세션 관찰이 아니다");
assert.equal(h.stale, 2, "창 밖 잔재는 숨기지 않고 센다");
assert.equal(h.verdict, "silent", "적은 nonzero 도 창 밖이면 죽은 것. 여기가 2026-07-16 실측 진범");
assert.equal(h.cause, "stale-only", "창 밖 기록만 존재 = STALE_ONLY(내부 원인). 대표 상태는 SILENT 로 낸다");
assert.match(h.text, /잔재 2건/, "잔재 사실을 사람에게 말한다");

// 창 안 기록이 있으면 정상.
h = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")], windowStart: "2026-07-15T14:30:40.156Z" });
assert.equal(h.verdict, "observed");
assert.equal(h.actions, 1);
assert.equal(h.stale, 0);
assert.equal(observationIncomplete(h), null);

// ── P0-3.5 4-2: seq 경계는 시간보다 우선한다(단조·시계 무관) ──
// 경계 seq=2 → seq<=2 는 stale, seq>2 만 이번 세션. 시간(windowStart)은 무시된다.
let hb = assess({ sites: SITE, records: [recSeq(1), recSeq(2), recSeq(3)], boundarySeq: 2, windowStart: null });
assert.equal(hb.actions, 1, "seq>2 인 것만 이번 세션 관찰(seq=3 하나)");
assert.equal(hb.stale, 2, "seq<=2 는 이전 세션 잔재");
assert.equal(hb.verdict, "observed");
// 경계 seq=2 에 새 기록이 없으면(seq 1,2 뿐) SILENT + stale 2 (owner 성공조건 1·2 의 관찰 축).
hb = assess({ sites: SITE, records: [recSeq(1), recSeq(2)], boundarySeq: 2, windowStart: null });
assert.equal(hb.actions, 0, "경계 이하만 있으면 이번 세션 관찰 0");
assert.equal(hb.stale, 2);
assert.equal(hb.verdict, "silent");
assert.equal(hb.cause, "stale-only", "창 밖 기록만 존재 = STALE_ONLY");
// 🔑 seq 경계는 시계를 안 본다: 미래 ts 라도 seq 가 경계 이하면 stale(시간 경계였다면 반대로 나옴).
hb = assess({ sites: SITE, records: [recSeq(2, "2099-01-01T00:00:00.000Z")], boundarySeq: 2, windowStart: "2026-07-15T00:00:00.000Z" });
assert.equal(hb.actions, 0, "seq<=경계면 미래 ts 라도 이번 세션 아님(seq 가 시간을 이긴다)");
// seq 없는 legacy 레코드는 시간 경계로 되돌아간다(경계 seq 있어도).
hb = assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")], boundarySeq: 2, windowStart: "2026-07-15T00:00:00.000Z" });
assert.equal(hb.actions, 1, "seq 없는 레코드는 시간으로 판정(증거를 안 버린다)");

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

// ── P0-2: 0 의 뜻을 구분한다. 넷을 구분 못 하는 계기의 0 은 거짓말이다 ──
// 🔑 2026-07-16 정정: '못 봤다'(not-observed)와 '꺼진 게 확인됐다'(recorder-off)는 다르다.
//    전자를 후자라고 부르면, 그것도 기계가 증명 못 한 원인 단정이다.
assert.equal(zeroMeaning(assess({ sites: SITE, records: [] })), "not-observed", "배선했는데 0 = 못 봤다(원인 미확정)");
assert.equal(zeroMeaning(assess({ sites: [], records: [] })), "recorder-off", "미배선은 기계가 확인 = 원인 확정 가능");
assert.doesNotMatch(ZERO_MEANING_TEXT["not-observed"], /꺼져/, "미확정을 '꺼짐'이라 부르지 않는다");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z"), { ts: "x", phase: "post", tool: "(capture)", op: "capture-degraded" }] })), "corrupted");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")] }), false), "no-input", "입력이 없으면 대조 미실행이지 0 이 아니다");
assert.equal(zeroMeaning(assess({ sites: SITE, records: [rec("2026-07-16T01:00:00.000Z")] }), true), "no-activity", "기록기 정상 + 입력 있음 = 진짜 없었음");
for (const k of ["no-activity", "not-observed", "recorder-off", "no-input", "corrupted"]) assert.ok(ZERO_MEANING_TEXT[k], `${k} 사람말 있음`);
// 대표 상태 코드 4종과 원인 코드 5종은 사람말이 다 있어야 한다(표시 누락 = 침묵).
for (const k of ["observed", "silent", "unavailable", "degraded"]) assert.ok(OBSERVATION_STATE_CODE[k], `${k} 코드 있음`);
for (const k of ["none", "no-wiring", "stale-only", "unknown", "corrupted"]) assert.ok(OBSERVATION_CAUSE_TEXT[k], `${k} 원인말 있음`);
assert.match(OBSERVATION_CAUSE_TEXT["unknown"], /미확정/, "미확정 원인은 미확정이라고 쓴다");

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

// ── P0-3.5 4-1: sessionCreator — 필드 없으면 legacy-unknown(begin/start 로 단정 금지) ──
assert.equal(sessionCreator(null), "legacy-unknown", "세션 없음 = legacy-unknown");
assert.equal(sessionCreator({ createdByCommand: "begin" }), "begin");
assert.equal(sessionCreator({ createdByCommand: "start" }), "start");
assert.equal(sessionCreator({ baselineHead: "x" }), "legacy-unknown", "🔑 v0.24 이전 세션은 legacy-unknown, 추측 금지");

console.log("observation.test.mjs OK");
