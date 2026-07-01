// ── best-effort 민감정보 마스킹 ──
// 목적: receipt/audit-pack 산출(특히 복사된 .env/계약/claim 텍스트)에 비밀값이 남는 위험 감소.
// 원칙(정체성 가드): "완벽한 비밀정보 탐지"가 아니다 — 한계 고지 필수(REDACT_NOTE).
//        경로·파일명·해시는 보존하고, 민감 key 의 "값"만 [REDACTED] 로 치환한다.
// 새 의존성 0(순수 정규식). 결정론적(입력 같으면 출력 같음).

export const REDACTED = "[REDACTED]";

export const REDACT_NOTE =
  "redact 는 best-effort 입니다 — 모든 비밀정보를 잡는다고 보장하지 않습니다. 민감 산출물은 직접 재확인하세요.";

// 민감 key 이름(좌변). 대소문자 무시. KEY=VALUE / "key": "value" / key: value 공통.
const SENSITIVE_KEY =
  "(?:[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|authorization|access[_-]?key|private[_-]?key|client[_-]?secret|webhook|session|cookie)[A-Za-z0-9_.-]*)";

// 1) .env / shell 형태:  SOME_SECRET=값   (값 끝까지)
const ENV_ASSIGN = new RegExp(`^(\\s*(?:export\\s+)?${SENSITIVE_KEY}\\s*=\\s*)(.+)$`, "gim");
// 2) json/yaml 형태:  "secret": "값"  또는  secret: 값   (콤마/중괄호/줄끝 전까지)
const KV_COLON = new RegExp(`("?${SENSITIVE_KEY}"?\\s*:\\s*)("?)([^"\\n,}]+)("?)`, "gi");
// 3) Bearer 토큰
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._\-]+/gi;
// 4) 흔한 고신뢰 토큰 접두(값 자체로 식별 가능) — sk-, ghp_/gho_/ghs_, AKIA, xoxb/xoxp
const TOKEN_SHAPES =
  /\b(sk-[A-Za-z0-9]{8,}|gh[posu]_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|xox[bpars]-[A-Za-z0-9-]{8,})\b/g;

export interface RedactResult {
  text: string;
  count: number; // 총 치환 건수
  strong: number; // 그 중 "값 자체로 식별되는 강한 비밀"(Bearer/sk-/ghp_/AKIA/xox) 건수 — strict-redact 거부 판단용
}

// 텍스트(파일 내용/로그)에서 민감값을 best-effort 로 가린다. 치환 건수 + 강한-비밀 건수를 함께 반환.
// strong 은 shape 로 식별되는 고신뢰 토큰만 센다(엔트로피 스캔 안 함 — sha256 등 해시 오탐 방지, council C5).
export function redactText(input: string): RedactResult {
  let count = 0;
  let strong = 0;
  let out = input;
  // 강한 shape(Bearer/sk-/ghp_/AKIA/xox)를 먼저 가린다 → key:value 안에 있어도 strong 으로 분류
  // (strict-redact 정확도). 최종 마스킹 텍스트는 순서와 무관하게 동일하다.
  out = out.replace(BEARER, (_m, pre) => {
    count++;
    strong++;
    return `${pre}${REDACTED}`;
  });
  out = out.replace(TOKEN_SHAPES, () => {
    count++;
    strong++;
    return REDACTED;
  });
  out = out.replace(ENV_ASSIGN, (_m, pre) => {
    count++;
    return `${pre}${REDACTED}`;
  });
  out = out.replace(KV_COLON, (_m, pre, q1, _v, q2) => {
    count++;
    return `${pre}${q1}${REDACTED}${q2}`;
  });
  return { text: out, count, strong };
}

// ── JSON 구조 인식 redactor ──
// text 정규식(redactText)은 JSON 값 자리에 따옴표 없는 [REDACTED] 를 넣어 JSON 을 깨고,
// session/secretFilesRead 같은 "구조 키"를 비밀로 오인한다. 이 함수는 파싱→값 단위로 마스킹→재직렬화해
// 유효 JSON 을 보장하고 키 오탐을 없앤다. 규칙:
//   (1) 키가 SENSITIVE_KEY 매칭 + 값이 "문자열" → 값 전체 [REDACTED](예: "api_key":"abc").
//       객체/배열/숫자/null 값은 보존 → session(객체)·secretFilesRead(배열) 오탐 제거.
//   (2) 모든 문자열 값 "내부"의 강한 토큰(sk-/ghp_/AKIA/xox/Bearer)은 부분 마스킹(strong).
//   (3) 키는 절대 건드리지 않는다.
// 파싱 실패(비-JSON/이미 깨진 입력) → text redactText 로 폴백(never throw).
const FULL_SENSITIVE_KEY = new RegExp(`^${SENSITIVE_KEY}$`, "i");

// 문자열 값 내부의 강한 토큰만 부분 마스킹(shape 식별). key 신호와 무관하게 항상 적용.
function redactShapesInString(s: string, ctr: { count: number; strong: number }): string {
  let out = s.replace(BEARER, (_m, pre) => {
    ctr.count++;
    ctr.strong++;
    return `${pre}${REDACTED}`;
  });
  out = out.replace(TOKEN_SHAPES, () => {
    ctr.count++;
    ctr.strong++;
    return REDACTED;
  });
  return out;
}

function redactWalk(v: unknown, keySensitive: boolean, ctr: { count: number; strong: number }): unknown {
  if (typeof v === "string") {
    if (keySensitive) {
      ctr.count++;
      return REDACTED; // 민감 키의 문자열 값 전체 마스킹
    }
    return redactShapesInString(v, ctr);
  }
  if (Array.isArray(v)) return v.map((x) => redactWalk(x, false, ctr));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = redactWalk(val, FULL_SENSITIVE_KEY.test(k), ctr);
    }
    return o;
  }
  return v; // number/boolean/null 보존
}

export function redactJsonText(input: string): RedactResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return redactText(input); // 폴백: 비-JSON/깨진 입력은 text 경로(never throw)
  }
  const ctr = { count: 0, strong: 0 };
  const red = redactWalk(parsed, false, ctr);
  return { text: JSON.stringify(red, null, 2) + "\n", count: ctr.count, strong: ctr.strong };
}
