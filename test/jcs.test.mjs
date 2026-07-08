// RFC 8785(JCS) 적합성 벡터 동결 · mcp-tap 3차 회의 Q1 결정의 기계 집행.
// 규율: 아래 벡터가 하나라도 깨지면 src/jcs.ts 의 JCS_DIGEST_ALG 를 "sorted/1" 로 강등해야 한다(과장 명칭 금지).
// 파일 규율: 벡터의 특수문자는 전부 코드로 조립한다(리터럴 제어문자·백슬래시 시퀀스 금지 · 인코딩/이스케이프 사고 방지).
import assert from "node:assert";
import { createHash } from "node:crypto";
import { jcsCanonicalize, jcsDigest, JCS_DIGEST_ALG } from "../dist/jcs.js";

const BS = String.fromCharCode(0x5c); // 백슬래시 1글자
const esc = (hex) => BS + "u" + hex; // JSON 이스케이프 시퀀스(백슬래시+u+hex4) 6글자를 만든다
const EURO = String.fromCharCode(0x20ac);
const C80 = String.fromCharCode(0x80);
const OUML = String.fromCharCode(0xf6);
const EMOJI = String.fromCharCode(0xd83d, 0xde00);
const DALET = String.fromCharCode(0xfb33);

// ── 1. RFC 8785 §3.2.3 공식 예제(입력·출력 그대로 동결) ──
// 입력 문자열 원문: eurosign, $, u+000F, u+000A, A, ', u+0042, u+0022, u+005C, 이스케이프백슬래시, 이스케이프따옴표, /
const rfcInput =
  '{ "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], ' +
  '"string": "' +
  esc("20ac") + "$" + esc("000F") + esc("000a") + "A'" + esc("0042") + esc("0022") + esc("005c") +
  BS + BS + BS + '"' + "/" +
  '", "literals": [null, true, false] }';
const rfcExpected =
  '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' +
  EURO + "$" + esc("000f") + BS + "n" + "A'B" + BS + '"' + BS + BS + BS + BS + BS + '"' + '/"}';
assert.equal(jcsCanonicalize(JSON.parse(rfcInput)), rfcExpected, "RFC 8785 3.2.3 예제");

// ── 2. RFC 8785 §3.2.3 키 정렬 예제(UTF-16 코드유닛 순 · 이모지 서러게이트가 u+FB33 앞) ──
const sortInput =
  '{"' + esc("20ac") + '":"Euro Sign",' +
  '"' + BS + 'r":"Carriage Return",' +
  '"' + esc("fb33") + '":"Hebrew Letter Dalet With Dagesh",' +
  '"1":"One",' +
  '"' + esc("d83d") + esc("de00") + '":"Emoji: Grinning Face",' +
  '"' + esc("0080") + '":"Control",' +
  '"' + esc("00f6") + '":"Latin Small Letter O With Diaeresis"}';
const sortExpected =
  '{"' + BS + 'r":"Carriage Return",' +
  '"1":"One",' +
  '"' + C80 + '":"Control",' +
  '"' + OUML + '":"Latin Small Letter O With Diaeresis",' +
  '"' + EURO + '":"Euro Sign",' +
  '"' + EMOJI + '":"Emoji: Grinning Face",' +
  '"' + DALET + '":"Hebrew Letter Dalet With Dagesh"}';
assert.equal(jcsCanonicalize(JSON.parse(sortInput)), sortExpected, "UTF-16 코드유닛 키 정렬");

// ── 3. 숫자 직렬화 표(ES6 Number toString == JCS 요구) ──
const nums = [
  ["0", "0"],
  ["-0", "0"], // 음의 영은 "0"
  ["1", "1"],
  ["-1", "-1"],
  ["0.5", "0.5"],
  ["1e21", "1e+21"],
  ["100000000000000000000", "100000000000000000000"], // 1e20 은 지수 없이
  ["0.000001", "0.000001"],
  ["1e-7", "1e-7"], // 1e-7 부터 지수 표기
  ["9007199254740992", "9007199254740992"], // 2^53
  ["9007199254740994", "9007199254740994"],
  ["333333333.33333329", "333333333.3333333"], // 배정도 반올림
  ["1E30", "1e+30"],
  ["4.50", "4.5"],
  ["2e-3", "0.002"],
  ["0.000000000000000000000000001", "1e-27"],
];
for (const [src, want] of nums) assert.equal(jcsCanonicalize(JSON.parse(src)), want, "숫자 " + src);

// ── 4. 비유한수 거부(결정 6: 호출부 canonFailed 폴백의 전제) ──
assert.throws(() => jcsCanonicalize(JSON.parse("1e999")), /non-finite/, "JSON.parse 오버플로(Infinity) 거부");
assert.throws(() => jcsCanonicalize(NaN), /non-finite/, "NaN 거부");
assert.throws(() => jcsCanonicalize(() => {}), /타입/, "JSON 밖 타입 거부");

// ── 5. 구조 규칙 ──
assert.equal(jcsCanonicalize({}), "{}");
assert.equal(jcsCanonicalize([]), "[]");
assert.equal(
  jcsCanonicalize({ b: { y: 1, x: [{ q: 2, p: 1 }] }, a: 0 }),
  '{"a":0,"b":{"x":[{"p":1,"q":2}],"y":1}}',
  "재귀 정렬",
);
assert.equal(jcsCanonicalize([undefined]), "[null]", "배열 undefined 는 null(JSON.stringify 일치)");
assert.equal(jcsCanonicalize({ a: undefined, b: 1 }), '{"b":1}', "undefined 속성 생략(JSON.stringify 일치)");
// 외톨이 서러게이트: ES2019+ 정형(well-formed) JSON.stringify 의 소문자 이스케이프 유지.
const LONE = esc("dead");
assert.equal(jcsCanonicalize(JSON.parse('"' + LONE + '"')), '"' + LONE + '"', "lone surrogate");

// ── 6. digest 배선(독립 경로 대조 · 동결) ──
const wantDigest = "sha256:" + createHash("sha256").update('{"a":1,"b":2}', "utf8").digest("hex");
assert.equal(jcsDigest({ b: 2, a: 1 }), wantDigest, "jcsDigest = 정규형 UTF-8 sha256");

// ── 7. 명칭 규율 동결 ──
// 이 단언이 있는 한, 위 벡터를 약화시키지 않고는 "jcs/sha256" 명칭을 유지할 수 없다.
assert.equal(JCS_DIGEST_ALG, "jcs/sha256", "벡터 전수 통과 상태의 명칭");

console.log("jcs.test: OK (RFC 8785 벡터 전수 통과 · jcs/sha256 명칭 유지)");
