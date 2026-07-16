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

/** 관찰 판정. 우선순위(결정론): degraded > wired-silent > not-wired > observed. */
export type ObservationVerdict = "observed" | "not-wired" | "wired-silent" | "degraded";

/** 0 의 네 가지 뜻. 같은 숫자 0 이라도 병이 다르고 수리 지점이 다르다. */
export type ZeroMeaning = "no-activity" | "recorder-off" | "no-input" | "corrupted";

export interface WiringSite {
  path: string; // 훅이 발견된 settings 파일
  events: string[]; // 그 파일에서 배선된 이벤트(PreToolUse 등)
}

export interface ObservationHealth {
  verdict: ObservationVerdict;
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
      text: `행동 관찰 기록이 손상됨(${parts.join(" · ")}). 기록된 숫자를 그대로 믿을 수 없음`,
      fix: "`agent-receipt capture verify` 로 상세 확인 후, 원인 해소하고 `agent-receipt begin` 으로 새 창 시작",
    };
  }

  // 2) wired-silent: 훅은 배선됐는데 측정 창 안에 행동이 없다. 실측으로 확인된 진짜 고장.
  //    창 밖 잔재(stale)가 있어도 이번 세션 관찰은 0이다. 그 사실을 숨기지 않고 같이 낸다.
  if (wired && actions === 0) {
    const staleNote = stale ? ` (측정 창 밖 잔재 ${stale}건은 이전 창 기록이라 이번 세션 관찰이 아님${base.lastTs ? `, 마지막 수신 ${base.lastTs}` : ""})` : "";
    return {
      ...base,
      verdict: "wired-silent",
      text: `capture 훅이 배선돼 있는데 측정 창 안 행동 기록이 0건. 훅이 실행되지 않고 있음(승인 대기이거나 세션이 배선 이전에 시작됨)${staleNote}`,
      fix: "Claude Code 를 새 세션으로 다시 시작하고 훅 승인 여부를 확인. 그 뒤 파일을 하나 고쳐 `.agent-guard/capture.jsonl` 이 자라는지 볼 것",
    };
  }

  // 3) not-wired: 훅 자체가 없다. git 전용 사용자의 정상 상태이므로 고장이 아니다.
  //    다만 이 영수증이 git 만 봤다는 사실은 반드시 밝힌다(과대 주장 금지).
  if (!wired) {
    return {
      ...base,
      verdict: "not-wired",
      text: "capture 훅 미배선. 이 영수증의 관찰 범위는 git 변경 한정이며 도구 행동·읽기·네트워크는 측정되지 않음",
      fix: "행동까지 남기려면 `agent-receipt capture install --write` 후 새 세션 시작",
    };
  }

  // 4) observed: 배선 + 측정 창 안 수신 확인.
  return { ...base, verdict: "observed", text: `행동 관찰 정상. 측정 창 안 ${actions}건 수신(세션 ${sessions})`, fix: null };
}

/**
 * 0 의 정체를 관찰 상태로 해석한다. 같은 0 이라도 병이 다르다.
 * hasInput=false 는 "비교할 입력 자체가 없었다"(예: git 변경 0)를 뜻하며 계기 고장이 아니다.
 */
export function zeroMeaning(h: ObservationHealth, hasInput = true): ZeroMeaning {
  if (h.verdict === "degraded") return "corrupted";
  if (h.verdict === "not-wired" || h.verdict === "wired-silent") return "recorder-off";
  if (!hasInput) return "no-input";
  return "no-activity";
}

export const ZERO_MEANING_TEXT: Record<ZeroMeaning, string> = {
  "no-activity": "실제로 행동이 없었음(기록기 정상)",
  "recorder-off": "기록기가 꺼져 있었음. 0 은 '없었다'가 아니라 '못 봤다'",
  "no-input": "비교할 입력이 제공되지 않음. 대조 미실행",
  corrupted: "기록이 손상됨. 숫자를 믿을 수 없음",
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
  "not-wired": "·",
  "wired-silent": "⚠",
  degraded: "⚠",
};
