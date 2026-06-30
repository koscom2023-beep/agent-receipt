import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { redactText, REDACT_NOTE } from "./redact.js";
import * as g from "./git.js";

// ── capture (alpha) — git 너머 '측정' 행위 추적 ──
// 4차 council Decision #1: 에이전트가 git diff 에 안 남기는 행위(.env 읽기·외부 호출·생성후삭제 등)를
// Claude Code PreToolUse/PostToolUse 훅 stdin(JSON)에서 받아 마스킹 후 append-only 로 기록한다.
// 원칙: 값 저장 0(경로/호스트/행위분류만·redact 경유) · 차단 안 함(증거지 게이트 아님) · 새 의존성 0.
// 한계(alpha): 어댑터=Claude Code 단일(중립 '지향'). gitVisible 은 캡처된 경로 ∩ git 변경집합 휴리스틱
//   — 영수증 14키 사이드카 임베드(actions[])는 다음 iteration(골든 바이트불변 검증 동반).

export type ActionFlag =
  | "READ_SECRET_FILE"
  | "FILE_READ"
  | "EXTERNAL_NETWORK_CALL"
  | "CREATED_THEN_DELETED"
  | "FILE_WRITE"
  | "COMMAND_RUN";

export interface CaptureRecord {
  ts: string;
  phase: "pre" | "post";
  tool: string;
  op: "read" | "write" | "delete" | "network" | "command";
  path?: string;
  host?: string;
}

export interface CaptureAction {
  tool: string;
  op: CaptureRecord["op"];
  path?: string;
  host?: string;
  flag: ActionFlag;
}

export interface ActionsResult {
  actions: CaptureAction[];
  actionsSummary: {
    total: number;
    secretFilesRead: number;
    externalCalls: number;
    createdThenDeleted: number;
    gitVisible: number;
  };
}

// ── 표시 필터 (council 5 Decision #2) — 데모 임팩트: '무서운 행위'만 개별 노출, 일반 read/command 는 강등.
// 데이터(actions[]·요약·영수증 임베드 JSON·contentHash)는 미변경 — 증거는 전부 기록하고 *화면에서만* 접는다.
// 경계는 기존 flag 분류 재사용(작품/시나리오 문자열 박지 않음 — 범용).
export const NOTABLE_FLAGS: ReadonlySet<ActionFlag> = new Set<ActionFlag>([
  "READ_SECRET_FILE",
  "EXTERNAL_NETWORK_CALL",
  "CREATED_THEN_DELETED",
]);
export function isNotableAction(a: { flag: ActionFlag }): boolean {
  return NOTABLE_FLAGS.has(a.flag);
}
/** 표시용 분할: 무서운 행위(개별 노출) ⟷ 일반 행위 건수(접힘). 증거 데이터는 불변. */
export function splitActionsForDisplay(actions: CaptureAction[]): { notable: CaptureAction[]; mutedCount: number } {
  const notable = actions.filter(isNotableAction);
  return { notable, mutedCount: actions.length - notable.length };
}

// 비밀로 취급하는 경로(읽기 시 READ_SECRET_FILE). 경로 '이름'만 봄(내용 아님).
const SECRET_PATH = /(^|\/)\.env(\.|$|\b)|\.(key|pem|p12|pfx|keystore)$|(^|\/)(id_rsa|id_ed25519|id_dsa)$|secret|credential/i;
const NET_CMD = /\b(curl|wget|nc|ncat|telnet|scp|rsync|sftp|ssh|aria2c|lynx|httpie)\b/;
// 스크립트 내부 HTTP(파이썬/노드/루비/PHP 등) — curl 류 외 "외부 호출"도 잡는다(item3 강화).
const NET_LIB = /(requests\.(?:get|post|put|delete|patch|head|request)|urllib|http\.client|httpx|aiohttp|\bfetch\s*\(|axios|XMLHttpRequest|HTTParty|Net::HTTP|file_get_contents|curl_exec)/;
const URL_RE = /https?:\/\/([^/\s'"]+)/i;
const FIND_DELETE_RE = /\bfind\b[^|;&]*-delete\b/;

// Bash 명령에서 삭제 대상 경로들 추출 — rm a b c · rm -rf x · unlink · find … -delete (다중 경로·item3).
function extractDeletePaths(cmd: string): string[] {
  const out: string[] = [];
  if (FIND_DELETE_RE.test(cmd)) {
    const root = cmd.match(/\bfind\s+([^\s|;&]+)/);
    out.push(root?.[1] ?? "(find -delete)");
  }
  for (const seg of cmd.split(/[;&|]+/)) {
    const m = seg.match(/\b(?:rm|unlink)\b(.*)/);
    if (!m) continue;
    for (const tok of m[1].split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue;
      out.push(tok.replace(/^['"]|['"]$/g, ""));
    }
  }
  return out;
}

function toRel(p: string): string {
  const root = g.repoRoot();
  if (!root || !p.startsWith("/")) return p;
  const r = relative(root, p);
  return r.startsWith("..") ? p : r; // 레포 밖이면 절대경로 유지
}
// 경로/호스트 문자열도 방어적으로 redact 경유(값 누수 차단). 내용·명령 바디는 *애초에 저장 안 함*.
function clean(s: string | undefined): string | undefined {
  return s ? redactText(s).text : s;
}

/** Claude Code 훅 payload(또는 {tool,input}) → CaptureRecord[](없으면 []). 값 미저장. 실제 envelope의 여분 필드(session_id 등)는 무시. */
export function classifyEvent(payload: unknown, phase: "pre" | "post" = "post", ts = ""): CaptureRecord[] {
  const o = payload as { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; input?: Record<string, unknown> };
  const tool = String(o?.tool_name ?? o?.tool ?? "");
  if (!tool) return [];
  const input = (o?.tool_input ?? o?.input ?? {}) as Record<string, unknown>;
  const base = { ts, phase, tool };
  const filePath = (): string | undefined => clean(toRel(String(input.file_path ?? input.notebook_path ?? input.path ?? "")));

  if (tool === "Read" || tool === "NotebookRead") {
    const path = filePath();
    return path ? [{ ...base, op: "read", path }] : [];
  }
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = filePath();
    return path ? [{ ...base, op: "write", path }] : [];
  }
  if (tool === "Bash") {
    const cmd = String(input.command ?? input.cmd ?? "");
    const url = cmd.match(URL_RE);
    if (url || NET_CMD.test(cmd) || NET_LIB.test(cmd)) {
      return [{ ...base, op: "network", host: clean(url?.[1]) ?? "(unknown-host)" }];
    }
    const dels = extractDeletePaths(cmd);
    if (dels.length) {
      return dels.map((p) => ({ ...base, op: "delete" as const, path: clean(toRel(p)) ?? p }));
    }
    return [{ ...base, op: "command" }];
  }
  return []; // 그 외 도구는 alpha 행위추적 비대상
}

/** records → actions[] + 요약. gitChangedPaths(주입 가능·테스트 결정론) ∩ 행위경로 = gitVisible. */
export function aggregateActions(records: CaptureRecord[], gitChangedPaths: Set<string> = new Set()): ActionsResult {
  const deletes = new Set<string>();
  for (const r of records) if (r.op === "delete" && r.path) deletes.add(r.path);

  const actions: CaptureAction[] = [];
  for (const r of records) {
    if (r.op === "delete") continue; // write 와 합치거나(create-then-delete) alpha 에선 단독 미표기
    let flag: ActionFlag;
    if (r.op === "read") flag = r.path && SECRET_PATH.test(r.path) ? "READ_SECRET_FILE" : "FILE_READ";
    else if (r.op === "network") flag = "EXTERNAL_NETWORK_CALL";
    else if (r.op === "write") flag = r.path && deletes.has(r.path) ? "CREATED_THEN_DELETED" : "FILE_WRITE";
    else flag = "COMMAND_RUN";
    actions.push({ tool: r.tool, op: r.op, path: r.path, host: r.host, flag });
  }

  return {
    actions,
    actionsSummary: {
      total: actions.length,
      secretFilesRead: actions.filter((a) => a.flag === "READ_SECRET_FILE").length,
      externalCalls: actions.filter((a) => a.flag === "EXTERNAL_NETWORK_CALL").length,
      createdThenDeleted: actions.filter((a) => a.flag === "CREATED_THEN_DELETED").length,
      gitVisible: actions.filter((a) => a.path && gitChangedPaths.has(a.path)).length,
    },
  };
}

function capFile(): string {
  const root = g.repoRoot() ?? process.cwd();
  return join(root, ".agent-guard", "capture.jsonl");
}

/**
 * 누적 capture.jsonl → ActionsResult. 레코드가 0이면 **null**(영수증 임베드 시 필드 자체를 안 단다 →
 * capture 안 쓰는 기존 사용자 receipt 바이트불변). gitChangedPaths 주입 가능(receipt 의 touched∪staged∪untracked
 * 재사용 → git 추가호출 0). council embed Decision #3.
 */
export function loadCapturedActions(gitChangedPaths: Set<string> = new Set()): ActionsResult | null {
  const records = readRecords();
  if (records.length === 0) return null;
  return aggregateActions(records, gitChangedPaths);
}
function safeList(fn: () => string[]): string[] {
  try {
    return fn();
  } catch {
    return [];
  }
}
function readRecords(): CaptureRecord[] {
  const f = capFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as CaptureRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is CaptureRecord => r !== null);
}

/** `agent-receipt capture [--event pre|post]` — 훅 stdin(JSON) 1건을 분류·마스킹·append. 항상 통과(비차단). */
export function runCaptureIngest(event: string | undefined): never {
  const phase: "pre" | "post" = event === "pre" ? "pre" : "post";
  if (process.stdin.isTTY) process.exit(0); // 파이프 입력 없으면 무동작
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 파싱 실패도 통과(증거지 게이트 아님)
  }
  const recs = classifyEvent(payload, phase, new Date().toISOString());
  if (recs.length) {
    const f = capFile();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  process.exit(0);
}

/** `agent-receipt capture show [--json]` — 누적 capture.jsonl 집계 출력(데모 핵심: git:N ⟷ 행위:M). */
export function runCaptureShow(json: boolean): never {
  const records = readRecords();
  const gitChanged = new Set<string>([
    ...safeList(g.unstagedFiles),
    ...safeList(g.stagedFiles),
    ...safeList(g.untrackedFiles),
  ]);
  const result = aggregateActions(records, gitChanged);
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  }
  const s = result.actionsSummary;
  const { notable, mutedCount } = splitActionsForDisplay(result.actions);
  console.log(`\nagent-receipt capture (alpha) — git 너머 행위 ${s.total}건 (주목 ${notable.length})`);
  for (const a of notable) console.log(`  ⚠️ ${a.flag}  ${a.path ?? a.host ?? ""}`);
  if (mutedCount) console.log(`  · 그 외 일반 read/command ${mutedCount}건 (기록됨·접힘)`);
  console.log(`\n  git 가 보는 것: ${s.gitVisible}  ⟷  주목 행위: ${notable.length}  (전체 기록 ${s.total})`);
  console.log(`  값은 저장하지 않습니다 — 경로/호스트/행위분류만. ${REDACT_NOTE}`);
  process.exit(0);
}

/** capture 로그를 조용히 비운다(비exit·무출력) — begin(새 baseline)/reset 에서 재사용. council A #1. */
export function clearCaptureLog(): void {
  const f = capFile();
  try {
    if (existsSync(f)) rmSync(f);
  } catch {
    /* noop */
  }
}

/** `agent-receipt capture reset` — 캡처 로그 초기화(새 세션 시작용). */
export function runCaptureReset(): never {
  clearCaptureLog();
  console.log("capture 로그 초기화됨.");
  process.exit(0);
}

// ── Claude Code 훅 자동배선 (capture install) — council A Decision #2/#3 ──
// .claude/settings.json 의 hooks.PreToolUse/PostToolUse 에 `agent-receipt capture` 추가.
// 기본 --print(미리보기·무쓰기), 실제 쓰기는 --write opt-in. 머지는 멱등·기존 보존·malformed 거부.
const HOOK_MATCHER = "Bash|Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead";
const captureCommand = (phase: "pre" | "post"): string => `agent-receipt capture --event ${phase}`;

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}
export interface SettingsShape {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

/** 순수함수: settings 객체에 capture 훅을 멱등 추가(기존 항목 보존). {merged, changed}. */
export function mergeCaptureHooks(input: SettingsShape): { merged: SettingsShape; changed: boolean } {
  const merged: SettingsShape = JSON.parse(JSON.stringify(input ?? {}));
  if (!merged.hooks || typeof merged.hooks !== "object") merged.hooks = {};
  let changed = false;
  const phases: Array<["PreToolUse" | "PostToolUse", "pre" | "post"]> = [
    ["PreToolUse", "pre"],
    ["PostToolUse", "post"],
  ];
  for (const [key, phase] of phases) {
    const cmd = captureCommand(phase);
    const arr: HookEntry[] = Array.isArray(merged.hooks[key]) ? merged.hooks[key] : [];
    const present = arr.some((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === cmd));
    if (!present) {
      arr.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: cmd }] });
      changed = true;
    }
    merged.hooks[key] = arr;
  }
  return { merged, changed };
}

/** 순수함수: capture 훅만 제거(우리 command 접두 매칭). {merged, changed}. */
export function removeCaptureHooks(input: SettingsShape): { merged: SettingsShape; changed: boolean } {
  const merged: SettingsShape = JSON.parse(JSON.stringify(input ?? {}));
  let changed = false;
  if (merged.hooks && typeof merged.hooks === "object") {
    for (const key of ["PreToolUse", "PostToolUse"]) {
      const arr = merged.hooks[key];
      if (!Array.isArray(arr)) continue;
      const kept = arr.filter((e) => {
        const ours = Array.isArray(e?.hooks) && e.hooks.some((h) => typeof h?.command === "string" && h.command.startsWith("agent-receipt capture"));
        if (ours) changed = true;
        return !ours;
      });
      if (kept.length) merged.hooks[key] = kept;
      else delete merged.hooks[key];
    }
    if (Object.keys(merged.hooks).length === 0) delete merged.hooks;
  }
  return { merged, changed };
}

function settingsPath(global: boolean): string {
  return global ? join(homedir(), ".claude", "settings.json") : join(process.cwd(), ".claude", "settings.json");
}

/** `agent-receipt capture install [--write] [--global]` — 기본 print(무쓰기), --write 시에만 병합 기록. */
export function runCaptureInstall(write: boolean, global: boolean): never {
  if (!write) {
    const { merged } = mergeCaptureHooks({});
    console.log("\n# .claude/settings.json 에 병합할 hooks (기존 설정 보존):");
    console.log(JSON.stringify(merged, null, 2));
    console.log("\n자동 병합: agent-receipt capture install --write       (프로젝트 ./.claude/settings.json)");
    console.log("전역 적용:  agent-receipt capture install --write --global  (~/.claude/settings.json)");
    process.exit(0);
  }
  const p = settingsPath(global);
  let existing: SettingsShape = {};
  if (existsSync(p)) {
    try {
      existing = JSON.parse(readFileSync(p, "utf8")) as SettingsShape;
    } catch {
      console.error(`✗ ${p} 파싱 실패(주석/형식 문제 가능) — 자동 수정 거부. 'capture install'(--write 없이)로 snippet 을 보고 직접 병합하세요.`);
      process.exit(2);
    }
  }
  const { merged, changed } = mergeCaptureHooks(existing);
  if (!changed) {
    console.log(`이미 설치됨(멱등): ${p}`);
    process.exit(0);
  }
  if (global) console.log("⚠️ 전역 설정(~/.claude)을 수정합니다.");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✅ capture 훅 설치: ${p} (기존 설정 보존·우리 항목만 추가)`);
  process.exit(0);
}

/** `agent-receipt capture uninstall [--write] [--global]` — capture 훅만 제거. 기본 print. */
export function runCaptureUninstall(write: boolean, global: boolean): never {
  const p = settingsPath(global);
  if (!existsSync(p)) {
    console.log(`설정 없음: ${p}`);
    process.exit(0);
  }
  let existing: SettingsShape;
  try {
    existing = JSON.parse(readFileSync(p, "utf8")) as SettingsShape;
  } catch {
    console.error(`✗ ${p} 파싱 실패 — 자동 수정 거부. 직접 제거하세요.`);
    process.exit(2);
  }
  const { merged, changed } = removeCaptureHooks(existing);
  if (!changed) {
    console.log("제거할 capture 훅 없음.");
    process.exit(0);
  }
  if (!write) {
    console.log("제거 미리보기(--write 로 적용):");
    console.log(JSON.stringify(merged, null, 2));
    process.exit(0);
  }
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✅ capture 훅 제거: ${p}`);
  process.exit(0);
}
