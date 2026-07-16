// 관찰 상태(observation). "이 영수증이 무엇을 봤는가"를 판정한다.
//
// 배경(2026-07-16 전수 실측): 44일간 capture 기록이 실제로 0건이었는데, 영수증 308건이
// 7/3 테스트 probe 2줄을 반복 인용하며 PASS 를 찍었다. 봉인(해시·서명·Rekor)은 전부 정상이었다.
// 즉 자물쇠는 튼튼한데 상자가 비어 있었고, 계기는 그 사실을 말하지 않았다.
//
// 원칙 두 개:
//   1) 관찰이 비어 있으면 PASS 를 찍지 않는다. 봉인 강도는 내용물의 가치를 넘지 못한다.
//   2) 0 은 네 가지 뜻이 있다(행동없음 / 기록기꺼짐 / 입력없음 / 손상됨). 넷을 구분하지 못하는
//      계기가 찍는 0 은 거짓말이다. 그래서 여기서 0 의 정체를 함께 낸다.
//
// 이 모듈은 순수 판정 + 얇은 디스크 읽기다. 새 CLI 명령을 만들지 않는다(정본 STOP 목록).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as g from "./git.js";
import { CAPTURE_COMMAND_PREFIX, HOOK_EVENT_KEYS, readCaptureRecords, type CaptureRecord, type SettingsShape } from "./capture.js";
import { loadSession } from "./session.js";

/**
 * 사용자 대표 상태(관찰 상태). 우선순위(결정론): degraded > unavailable > silent > observed.
 *
 * 왜 이 어휘인가(2026-07-16 owner 정정): 이전 이름 wired-silent 는 "훅이 배선됐는데 안 돈다"는
 * 원인 단정을 이름에 박아 넣었다. 기계가 증명한 것은 "창 안 기록을 못 받았다" 뿐이다.
 *   observed     측정 창 안 행동 기록이 있음
 *   silent       측정 창 안 기록이 없고 원인은 아직 모름
 *   unavailable  훅 미설치·비활성·미지원이 기계적으로 확인됨
 *   degraded     기록이 손상돼 숫자를 믿을 수 없음
 */
export type ObservationVerdict = "observed" | "silent" | "unavailable" | "degraded";

/**
 * 내부 원인 코드. 대표 상태와 분리한다 — STALE_ONLY 와 SILENT 는 동시에 참일 수 있기 때문이다.
 * 대표 상태는 사용자가 읽고, 원인 코드는 진단이 읽는다. 확정하지 못한 원인은 unknown 으로 둔다.
 */
export type ObservationCause = "none" | "no-wiring" | "stale-only" | "unknown" | "corrupted";

/**
 * 0 의 뜻. 같은 숫자 0 이라도 병이 다르고 수리 지점이 다르다.
 * recorder-off 는 기계가 미배선을 확인했을 때만 쓴다. 못 봤을 뿐인 것을 껐다고 부르면 그것도 거짓말이다.
 */
export type ZeroMeaning = "no-activity" | "not-observed" | "recorder-off" | "no-input" | "corrupted";

export interface WiringSite {
  path: string; // 훅이 발견된 settings 파일
  events: string[]; // 그 파일에서 배선된 이벤트(PreToolUse 등)
}

export interface ObservationHealth {
  verdict: ObservationVerdict; // 사용자 대표 상태
  cause: ObservationCause; // 내부 원인 코드(대표 상태와 분리 — 미확정이면 unknown)
  wired: boolean; // capture 훅이 어느 settings 에든 배선돼 있나
  sites: WiringSite[]; // 배선 위치(사람이 고치러 갈 곳)
  logExists: boolean; // .agent-guard/capture.jsonl 존재
  total: number; // 총 레코드(열화 마커 포함·창 무관)
  actions: number; // 측정 창 안의 실제 행동 레코드(열화 마커 제외). 판정은 이 값이 기준
  stale: number; // 측정 창보다 오래된 행동 레코드(이전 창 잔재이므로 이번 세션 관찰이 아님)
  degraded: number; // capture-degraded 마커 수(조용한 누락이 아닌 정직한 갭)
  lastTs: string | null; // 마지막 수신 시각(ISO·창 무관)
  windowStart: string | null; // 측정 창 시작(session.createdAt). null 이면 창 없음(전체를 창으로 본다)
  sessions: number; // 창 안 레코드의 서로 다른 sessionId 수
  text: string; // 사람이 읽는 사실
  fix: string | null; // 고치는 법(고정 매핑이지 추천이 아님). observed 면 null
}

/** capture 훅이 심어져 있는지 순수 판정. command 접두는 install/uninstall 과 같은 원천을 쓴다. */
export function detectWiring(settings: SettingsShape | null): string[] {
  if (!settings || !settings.hooks || typeof settings.hooks !== "object") return [];
  const found: string[] = [];
  for (const key of HOOK_EVENT_KEYS) {
    const arr = settings.hooks[key];
    if (!Array.isArray(arr)) continue;
    const ours = arr.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.startsWith(CAPTURE_COMMAND_PREFIX)));
    if (ours) found.push(key);
  }
  return found;
}

/** 관찰 상태를 검사할 settings 파일 목록(프로젝트, 프로젝트 local, 전역). 읽기 전용이라 넓게 본다. */
export function settingsCandidates(cwd: string): string[] {
  const root = g.repoRoot() ?? cwd;
  return [join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json"), join(homedir(), ".claude", "settings.json")];
}

function readSettings(p: string): SettingsShape | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SettingsShape;
  } catch {
    return null; // 깨진 settings 는 배선 판정 불가이므로 없음으로 취급(크래시 금지)
  }
}

export interface AssessInput {
  sites: WiringSite[];
  logExists: boolean;
  records: CaptureRecord[];
  chainProblems: number;
  truncated: boolean;
  /**
   * 측정 창 시작(session.createdAt·ISO). null 이면 창 없음이므로 전체를 창으로 본다.
   * 왜 필요한가(2026-07-16 실측): promptia 는 창이 7/15 인데 capture 마지막 기록이 7/3 이었다.
   * 즉 훅이 12일째 죽어 있는데 "기록 2건"이라 정상으로 보였다. 적은 nonzero 는 0 만큼이나 죽어 있다.
   * 창 밖 잔재를 이번 세션의 관찰로 세면 계기가 거짓말을 한다. 임의 임계값 대신 창 경계를 쓴다.
   */
  windowStart: string | null;
}

/** 레코드가 측정 창 안인가. ts 파싱 실패는 창 안으로 본다(못 읽는다고 증거를 버리지 않는다). */
function inWindow(r: CaptureRecord, windowStart: string | null): boolean {
  if (!windowStart) return true;
  const t = Date.parse(r.ts);
  const w = Date.parse(windowStart);
  if (Number.isNaN(t) || Number.isNaN(w)) return true;
  return t >= w;
}

/** 순수 판정. 디스크를 안 읽는다. 테스트가 여기에 직접 값을 넣는다. */
export function assessObservation(i: AssessInput): ObservationHealth {
  const wired = i.sites.length > 0;
  const degraded = i.records.filter((r) => r.op === "capture-degraded").length;
  const realRecords = i.records.filter((r) => r.op !== "capture-degraded");
  const windowed = realRecords.filter((r) => inWindow(r, i.windowStart));
  const actions = windowed.length;
  const stale = realRecords.length - windowed.length;
  const last = i.records.length ? i.records[i.records.length - 1] : null;
  const sessions = new Set(windowed.map((r) => r.sessionId).filter((s): s is string => typeof s === "string" && s.length > 0)).size;
  const base = {
    wired,
    sites: i.sites,
    logExists: i.logExists,
    total: i.records.length,
    actions,
    stale,
    degraded,
    lastTs: last?.ts ?? null,
    windowStart: i.windowStart,
    sessions,
  };

  // 1) degraded: 기록이 손상됐거나 잘렸다. 숫자를 믿을 수 없다.
  if (degraded > 0 || i.chainProblems > 0 || i.truncated) {
    const parts: string[] = [];
    if (degraded) parts.push(`열화 마커 ${degraded}건`);
    if (i.chainProblems) parts.push(`체인 문제 ${i.chainProblems}건`);
    if (i.truncated) parts.push("꼬리 잘림 의심");
    return {
      ...base,
      verdict: "degraded",
      cause: "corrupted",
      text: `행동 관찰 기록이 손상됨(${parts.join(" · ")}). 기록된 숫자를 그대로 믿을 수 없음`,
      fix: "`agent-receipt capture verify` 로 상세 확인 후, 원인 해소하고 `agent-receipt begin` 으로 새 창 시작",
    };
  }

  // 2) unavailable: 훅 자체가 없다. 이건 기계가 확인한 사실이므로 원인을 말해도 된다.
  //    git 전용 사용자의 정상 상태이므로 고장이 아니다. 다만 관찰 범위가 git 한정이라는 사실은 반드시 밝힌다.
  if (!wired) {
    return {
      ...base,
      verdict: "unavailable",
      cause: "no-wiring",
      text: "capture 훅 미배선이 확인됨. 이 영수증의 관찰 범위는 git 변경 한정이며 도구 행동·읽기·네트워크는 측정되지 않음",
      fix: "행동까지 남기려면 `agent-receipt capture install --write` 후 새 세션 시작",
    };
  }

  // 3) silent: 훅은 배선됐는데 측정 창 안 행동이 0건.
  //    🔴 여기서 원인을 단정하지 않는다(2026-07-16 owner 정정). 기계가 아는 것은 "못 받았다" 뿐이고,
  //    가능한 원인은 미승인·실행 실패·다른 경로 세션 파일·미지원 도구·실제 무행동 등 여러 개다.
  //    창 밖 잔재(stale)가 있어도 이번 세션 관찰은 0이다. 그 사실을 숨기지 않고 같이 낸다.
  if (actions === 0) {
    const staleNote = stale ? ` (측정 창 밖 잔재 ${stale}건은 이전 창 기록이라 이번 세션 관찰이 아님${base.lastTs ? `, 마지막 수신 ${base.lastTs}` : ""})` : "";
    return {
      ...base,
      verdict: "silent",
      cause: stale ? "stale-only" : "unknown",
      text: `이번 측정 창에서 행동 관찰 증거를 받지 못함. 원인 미확정${staleNote}`,
      fix: "`agent-receipt doctor` 로 훅 설치·최근 수신 상태를 확인. 그 뒤 파일을 하나 고쳐 `.agent-guard/capture.jsonl` 이 자라는지 볼 것",
    };
  }

  // 4) observed: 배선 + 측정 창 안 수신 확인.
  return { ...base, verdict: "observed", cause: "none", text: `행동 관찰 정상. 측정 창 안 ${actions}건 수신(세션 ${sessions})`, fix: null };
}

/**
 * 0 의 정체를 관찰 상태로 해석한다. 같은 0 이라도 병이 다르다.
 * hasInput=false 는 "비교할 입력 자체가 없었다"(예: git 변경 0)를 뜻하며 계기 고장이 아니다.
 */
export function zeroMeaning(h: ObservationHealth, hasInput = true): ZeroMeaning {
  if (h.verdict === "degraded") return "corrupted";
  if (h.verdict === "unavailable") return "recorder-off"; // 미배선은 기계가 확인함 → 원인 단정 가능
  if (h.verdict === "silent") return "not-observed"; // 못 받았다는 사실만 확정 → 원인 단정 금지
  if (!hasInput) return "no-input";
  return "no-activity";
}

export const ZERO_MEANING_TEXT: Record<ZeroMeaning, string> = {
  "no-activity": "실제로 행동이 없었음(기록기 정상)",
  "not-observed": "이번 측정 창에서 행동 관찰 증거를 받지 못함. 0 은 '없었다'가 아니라 '못 봤다'",
  "recorder-off": "capture 훅 미배선이 확인됨. 이 영수증은 git 변경만 관찰함",
  "no-input": "비교할 입력이 제공되지 않음. 대조 미실행",
  corrupted: "기록이 손상됨. 숫자를 믿을 수 없음",
};

/** 사용자에게 보이는 관찰 상태 코드(대표 상태). */
export const OBSERVATION_STATE_CODE: Record<ObservationVerdict, string> = {
  observed: "OBSERVED",
  silent: "SILENT",
  unavailable: "UNAVAILABLE",
  degraded: "DEGRADED",
};

/**
 * 원인 줄. 확정한 것만 확정으로 쓴다.
 * SILENT 에서 가능한 원인을 나열하되 어느 하나를 고르지 않는다 — 고르면 그게 P0-2 가 고친 그 거짓말이다.
 */
export const OBSERVATION_CAUSE_TEXT: Record<ObservationCause, string> = {
  none: "해당 없음",
  "no-wiring": "확정. 어느 settings 에도 capture 훅이 없음",
  "stale-only": "미확정. 창 밖 기록만 존재(STALE_ONLY). 훅 설치·승인·최근 수신 상태 확인 필요",
  unknown: "미확정. 훅 설치·승인·실행 실패·미지원 도구·실제 무행동 중 어느 것인지 아직 모름",
  corrupted: "확정. 기록 자체가 손상됨",
};

/** 디스크에서 관찰 상태를 읽는다. 실패는 조용히 흡수한다(진단이 크래시하면 안 됨). */
export function loadObservationHealth(cwd: string = process.cwd()): ObservationHealth {
  const sites: WiringSite[] = [];
  for (const p of settingsCandidates(cwd)) {
    const events = detectWiring(readSettings(p));
    if (events.length) sites.push({ path: p, events });
  }
  const root = g.repoRoot() ?? cwd;
  const logPath = join(root, ".agent-guard", "capture.jsonl");
  const records = readCaptureRecords();
  // 측정 창은 session.createdAt 이다. begin 은 새 baseline 마다 capture 를 비우므로(begin.ts clearCaptureLog)
  // 정상 흐름이면 창 밖 잔재가 없다. 잔재가 있으면 그 자체가 신호다(begin 미실행 또는 비우기 실패).
  const windowStart = loadSession(cwd)?.createdAt ?? null;
  return assessObservation({ sites, logExists: existsSync(logPath), records, chainProblems: 0, truncated: false, windowStart });
}

export const OBSERVATION_MARK: Record<ObservationVerdict, string> = {
  observed: "✓",
  unavailable: "·", // 고장이 아니라 범위 공시(git 전용 사용자의 정상 상태)
  silent: "⚠",
  degraded: "⚠",
};
