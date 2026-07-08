// UX U7 — 핵심 경로 이중언어 골격(전면 i18n 아님·회의 결정: 핵심 20문자열만).
// 기본 lang = ko → 기존 출력 바이트 불변(글로벌 사용자만 --lang en / AGENT_RECEIPT_LANG=en 로 전환).
// 규율: 새 온보딩/멘탈모델 카피는 여기 등록해 "이중언어로 태어나게" 한다(4차 회의 DX). 전면 번역은 수요 후.
export type Lang = "ko" | "en";

let cached: Lang | null = null;

/** --lang <ko|en> 플래그 > AGENT_RECEIPT_LANG env > 기본 ko. 세션 내 1회 해석 후 캐시. */
export function resolveLang(argv: string[] = process.argv): Lang {
  if (cached) return cached;
  const i = argv.indexOf("--lang");
  const flag = i >= 0 ? argv[i + 1] : undefined;
  const v = (flag ?? process.env.AGENT_RECEIPT_LANG ?? "").toLowerCase();
  cached = v === "en" ? "en" : "ko"; // 기본 ko = 기존 바이트 불변
  return cached;
}

/** 테스트 전용 — 캐시 리셋(프로세스 재사용 시). */
export function resetLangCache(): void {
  cached = null;
}

type Str = { ko: string; en: string };

// 핵심 경로 문자열(온보딩·멘탈모델·다음 안내). id 는 안정 키.
const STRINGS: Record<string, Str> = {
  // U3 — 멘탈모델 1문장(help 최상단·done). "두 가지를 남긴다"로 영수증 2종 혼란 제거.
  "model.oneline": {
    ko: "이 도구는 두 가지를 남깁니다: AI가 한 일(Work Receipt = git 실측)과 AI가 한 말(Verification Receipt = 근거 대조).",
    en: "This tool leaves two things: what the AI did (Work Receipt = measured from git) and what the AI said (Verification Receipt = evidence checked against sources).",
  },
  // U1 — 첫 실행(계약 없음) 환영. 딱딱한 "계약이 없습니다" 대신 3줄 환영 + quickstart 우선.
  "welcome.hi": {
    ko: "agent-receipt — AI 코딩 세션을 계약하고, 끝나면 판정하고, 검증 가능한 영수증으로 남깁니다.",
    en: "agent-receipt — contract an AI coding session, get a verdict when it ends, keep a verifiable receipt.",
  },
  "welcome.start": {
    ko: "처음이면:  agent-receipt quickstart          (각 설정 단계가 무엇을 쓰는지 인쇄만 · 파일 무변경)",
    en: "First time?  agent-receipt quickstart          (prints what each setup step writes; changes nothing)",
  },
  "welcome.then": {
    ko: "그다음:    quickstart --write → begin → (작업) → done → share",
    en: "Then:        quickstart --write → begin → (work) → done → share",
  },
  // U2 — quickstart 핵심 3동사 축.
  "qs.core": {
    ko: "핵심은 세 동사입니다:  begin(시작) → done(판정) → share(공유). 나머지는 필요할 때만.",
    en: "The core is three verbs:  begin → done → share. Everything else is only when you need it.",
  },
  "qs.captureLater": {
    ko: "선택(나중에): capture 는 git 밖 행위까지 기록합니다. 첫 세션엔 없어도 됩니다.",
    en: "Optional (later): capture also records actions git can't see. You don't need it for your first session.",
  },
  // 공통 다음 안내.
  "next.begin": {
    ko: "다음: agent-receipt begin --kind implementation   (세션 시작 · 이때부터 측정)",
    en: "Next: agent-receipt begin --kind implementation   (start the session; measured from here)",
  },
};

/** 해석된(또는 지정) 언어로 문자열 반환. 미등록 id 는 id 그대로(개발 중 표면). */
export function t(id: string, lang: Lang = resolveLang()): string {
  const s = STRINGS[id];
  if (!s) return id;
  return s[lang];
}
