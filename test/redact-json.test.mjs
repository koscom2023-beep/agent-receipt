// redactJsonText — JSON 구조 인식 마스킹. text 정규식이 JSON 값을 깨던 버그의 근본 fix.
// `node test/redact-json.test.mjs`.
import assert from "node:assert/strict";
import { redactJsonText, redactText } from "../dist/redact.js";

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
const parse = (s) => JSON.parse(s); // 던지면 유효 JSON 아님

// ── 1) 구조 키 오탐 제거 + 유효 JSON: session(객체)·secretFilesRead(배열)·null 보존 ──
{
  const input = JSON.stringify({
    session: { applied: true, baselineHead: "abc1234" },
    environment: { secretFilesRead: [".env", ".env.local"], nodeVersion: "v20" },
    cookie: null,
  });
  const r = redactJsonText(input);
  let obj;
  check("유효 JSON 산출(구 버그: 따옴표 없는 [REDACTED])", () => {
    obj = parse(r.text);
  });
  check("session 객체 보존(오탐 아님)", () => assert.deepEqual(obj.session, { applied: true, baselineHead: "abc1234" }));
  check("secretFilesRead 배열 보존(경로=비밀값 아님)", () =>
    assert.deepEqual(obj.environment.secretFilesRead, [".env", ".env.local"]));
  check("cookie:null 보존", () => assert.equal(obj.cookie, null));
  check("구조 필드만 있을 때 count=0(오탐 0)", () => assert.equal(r.count, 0));
}

// ── 2) 진짜 비밀은 마스킹: 민감 키의 문자열 값 전체 ──
{
  const r = redactJsonText(JSON.stringify({ api_key: "abcTOKEN123", nested: { client_secret: "zzz" }, keep: "hello" }));
  const o = parse(r.text);
  check("민감 키(api_key) 문자열 값 → [REDACTED]", () => assert.equal(o.api_key, "[REDACTED]"));
  check("중첩 민감 키(client_secret) 값 마스킹", () => assert.equal(o.nested.client_secret, "[REDACTED]"));
  check("일반 키(keep) 값 보존", () => assert.equal(o.keep, "hello"));
  check("키 자체는 절대 안 건드림(api_key 키 존재)", () => assert.ok("api_key" in o));
  check("민감 키 문자열 2건 → count>=2", () => assert.ok(r.count >= 2));
}

// ── 3) 문자열 값 "내부" 강한 토큰 부분 마스킹(shape) → strong ──
{
  const r = redactJsonText(JSON.stringify({ note: "deploy used sk-ABCDEFGH1234 then done", n: 42, ok: true }));
  const o = parse(r.text);
  check("문자열 내부 sk- 토큰 마스킹", () => assert.ok(o.note.includes("[REDACTED]") && !o.note.includes("sk-ABCDEFGH")));
  check("문자열 나머지 텍스트 보존", () => assert.ok(o.note.startsWith("deploy used ") && o.note.endsWith(" then done")));
  check("숫자/불리언 보존", () => assert.equal(o.n, 42) & assert.equal(o.ok, true));
  check("강한 토큰 → strong>=1", () => assert.ok(r.strong >= 1));
}

// ── 4) 잘못된 입력 → text redactText 폴백(never throw) ──
{
  const bad = "not json at all: secret=sk-ZZZZZZZZ1234";
  const r = redactJsonText(bad);
  const t = redactText(bad);
  check("비-JSON 입력 → 폴백(throw 안 함)", () => assert.equal(typeof r.text, "string"));
  check("폴백 결과 = redactText 와 동일", () => assert.equal(r.text, t.text));
  check("폴백도 강한 토큰 마스킹", () => assert.ok(r.text.includes("[REDACTED]")));
}

// ── 5) 배열 안의 민감-shape 문자열도 마스킹 ──
{
  const r = redactJsonText(JSON.stringify({ items: ["ok", "Bearer ABC.def-123", "AKIAABCDEFGH1234"] }));
  const o = parse(r.text);
  check("배열 원소 Bearer 마스킹", () => assert.ok(o.items[1].includes("[REDACTED]")));
  check("배열 원소 AKIA 마스킹", () => assert.equal(o.items[2], "[REDACTED]"));
  check("배열 일반 원소 보존", () => assert.equal(o.items[0], "ok"));
}

if (fail.length) {
  console.error(`redact-json: ${pass} pass, ${fail.length} FAIL`);
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`redact-json: ${pass} pass ✅`);
