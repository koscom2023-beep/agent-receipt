import { createHash } from "node:crypto";

// RFC 8785 JSON Canonicalization Scheme(JCS) 자체 구현 · 신규 의존성 0.
// 결정 근거(mcp-tap 3차 회의 Q1): ES6 JSON.stringify 가 RFC 가 요구하는 숫자(ES6 Number::toString)와
// 문자열 직렬화를 그대로 제공하고, JS 기본 sort 가 UTF-16 코드유닛 키 정렬(RFC §3.2.3)과 일치한다.
// 어려운 것은 구현이 아니라 적합성 증명이므로 test/jcs.test.mjs 에 RFC 공식 예제 벡터를 동결한다.
//
// 명칭 규율(과장 명칭 금지): 동결 벡터가 전부 통과할 때만 "jcs/sha256" 라벨을 쓴다.
// 벡터가 하나라도 깨지면 이 상수를 "sorted/1" 로 강등해야 하며, 그 강등은 테스트가 강제한다.
// 알고리즘 교체 = 새 라벨(기존 영수증은 기존 라벨로 영원히 검증) · byte-invariant 철학의 알고리즘판.
export const JCS_DIGEST_ALG = "jcs/sha256";

/**
 * 값(파스 후 자료구조)을 RFC 8785 정규형 JSON 문자열로 직렬화한다.
 * digest 는 와이어 바이트가 아니라 "파스 후 값" 기준(송신측 직렬화 편차·중복 키는 JSON.parse last-wins 로 해소).
 * 비유한수(NaN/Infinity·JSON.parse("1e999") 포함)는 RFC 대로 거부(throw) ·
 * 호출부는 digest 를 만들지 않고 canonFailed 폴백(원시 frameDigest)을 쓴다(3차 회의 결정 6).
 */
export function jcsCanonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number 는 직렬화 불가(RFC 8785)");
      return JSON.stringify(value); // ES6 Number::toString(10) 과 동일(RFC 요구)
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value); // ES6 QuoteJSONString: 최소 이스케이프·소문자 \u00xx·비ASCII 리터럴(RFC 요구)
    case "object": {
      if (Array.isArray(value)) {
        // JSON.stringify 동작과 일치: 배열 원소 undefined 는 null 로.
        return "[" + value.map((v) => jcsCanonicalize(v === undefined ? null : v)).join(",") + "]";
      }
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).sort(); // 기본 sort = UTF-16 코드유닛 오름차순(RFC §3.2.3 정렬 규칙과 일치)
      const parts: string[] = [];
      for (const k of keys) {
        const v = o[k];
        if (v === undefined) continue; // JSON.stringify 와 동일: undefined 속성은 생략
        parts.push(JSON.stringify(k) + ":" + jcsCanonicalize(v));
      }
      return "{" + parts.join(",") + "}";
    }
    default:
      // bigint/function/symbol/undefined 루트 등 JSON 밖 타입 · JSON.parse 산출물에는 나타나지 않는다.
      throw new Error("JCS: 지원하지 않는 타입 " + typeof value);
  }
}

/** 정규형 문자열의 UTF-8 바이트에 대한 sha256("sha256:" 접두). tap record 의 argsDigest/resultDigest 가 쓴다. */
export function jcsDigest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(jcsCanonicalize(value), "utf8").digest("hex");
}
