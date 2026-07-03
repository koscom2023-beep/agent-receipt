import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, relative, isAbsolute, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { redactText, REDACT_NOTE } from "./redact.js";
import { withFileLock, writeFileAtomic } from "./lock.js";
import { isToolOutput } from "./session.js";
import { evalGuard } from "./guard.js";
import * as g from "./git.js";

// ── capture (alpha) — git 너머 '측정' 행위 추적 ──
// 4차 council Decision #1: 에이전트가 git diff 에 안 남기는 행위(.env 읽기·외부 호출·생성후삭제 등)를
// Claude Code PreToolUse/PostToolUse 훅 stdin(JSON)에서 받아 마스킹 후 append-only 로 기록한다.
// 원칙: 값 저장 0(경로/호스트/행위분류만·redact 경유) · 기본은 차단 안 함(증거 우선 — 실시간 차단은 policy `guard: block` opt-in 시 guard.ts) · 새 의존성 0.
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
  phase: "pre" | "post" | "fail" | "denied"; // fail=실패한 시도 · denied=권한 거부된 시도(PermissionDenied) — 값/에러텍스트 미저장
  tool: string;
  op: "read" | "write" | "delete" | "network" | "command" | "capture-degraded";
  path?: string;
  host?: string;
  reason?: string; // op=capture-degraded 일 때만(예: stdin 파싱 실패) — 조용한 누락 대신 정직한 갭 마커.
  // ── 완전성 보증 체인(6차 council iter1) — 변조·중간누락·재정렬 탐지. 레거시(이전 버전) 줄엔 부재. ──
  seq?: number; // 파일 내 단조 증가(누락 위치 = seq 불연속).
  sessionId?: string; // 훅 envelope의 session_id/sessionId/conversation_id(없으면 미기재) — 세션 격리.
  source?: string; // 행위 주체 에이전트(claude-code/codex/copilot/cursor) — 자기신고 라벨(증거 아님). 7차 council.
  prevHash?: string; // 직전 레코드의 entryHash(체인).
  entryHash?: string; // 이 레코드의 무결성 해시(entryHash 자신 제외, prevHash 포함).
  guard?: "warn" | "deny"; // 실시간 가드 판정(pre·write/delete 만) — warn=표시만, deny=차단 방출됨(policy guard: block). guard.ts
  guardRule?: string; // 매칭 근거 "origin:glob" (예: policy.forbidAlways:.env*)
  cmdHash?: string; // Bash 명령의 sha256 앞 16hex — *본문 미저장* 원칙 유지(동일 명령 반복 비교 전용 지문·값 복원 불가)
  cmdKind?: "test" | "build" | "lint" | "install" | "other"; // 명령 분류(정규식·본문 미저장) — 반복 표시용
}

export interface CaptureChainResult {
  problems: string[];
  verified: number;
  legacy: number;
}

// 캡처가 다루는 도구의 단일 출처(council iter1 D) — 훅 matcher·분류기 커버리지·caveat 가 공유.
// 정확한 사실(Phase6 정정): 목록 밖 도구는 "훅이 못 오는" 게 아니라 *이 목록으로 만든 matcher 가
//   안 매칭*해서 안 오는 것 — 그래서 여기 추가하면 잡힌다. 단 기존 설치본의 settings.json 에는
//   옛 matcher 가 박제돼 있으므로 `capture install --write` 재실행 후부터 적용(출력에 고지).
// Task·mcp__*(Phase7 편입·공식 훅 문서 실측): 둘 다 PreToolUse/PostToolUse 를 정상 발화하고
//   mcp 는 `mcp__<server>__<tool>` 이름으로 옴 — 기록은 *이름만*(op=command·파라미터/값 0·muted).
//   여전히 밖: PostToolUseFailure 등 다른 훅 이벤트(범위 밖 명시)·OS 레벨.
export const COVERED_TOOLS: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "Task",
  "mcp__*",
];

export interface CaptureAction {
  tool: string;
  op: CaptureRecord["op"];
  path?: string;
  host?: string;
  flag: ActionFlag;
  failed?: boolean; // PostToolUseFailure 유래 — *실패한 시도*(성공 행위와 절대 혼동 금지·표시 병기)
  denied?: boolean; // PermissionDenied 유래 — *권한이 거부한 시도*(실행 안 됨·표시 병기)
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
  if (!root || !isAbsolute(p)) return p; // 3R: isAbsolute(win32 인식) — startsWith("/")는 Windows 절대경로 못 잡음
  const r = relative(root, p);
  return (r.startsWith("..") ? p : r).split(sep).join("/"); // 레포 밖이면 절대경로 유지·구분자 forward-slash 통일(git 측과 교차되게)
}
// 경로/호스트 문자열도 방어적으로 redact 경유(값 누수 차단). 내용·명령 바디는 *애초에 저장 안 함*.
function clean(s: string | undefined): string | undefined {
  return s ? redactText(s).text : s;
}

export interface NormalizedEnvelope {
  tool_name: string;
  tool_input: Record<string, unknown>;
  sessionId?: string;
  source?: string;
}

/**
 * 7차 council: 벤더중립 envelope 정규화 토대 — 여러 코딩 에이전트 훅 stdin 을 classifyEvent 공통 모양으로.
 * Claude Code / Codex / Copilot(PascalCase)는 키가 동일 → passthrough. alias 하는 건 Copilot camelCase
 * (toolName/toolArgs)와 세션ID 변형(session_id/sessionId/conversation_id)뿐. **추정 0** — 미검증 특이사항
 * (Codex apply_patch 입력 shape·Cursor 전용 이벤트)은 매핑하지 않음(정찰 '실측 권장' 준수 → 미커버 tool 은 classifyEvent 가 []).
 * source(행위 주체)는 명시될 때만(자기신고 라벨·증거 아님).
 */
export function normalizeEnvelope(payload: unknown): NormalizedEnvelope {
  const o = (payload ?? {}) as Record<string, unknown>;
  const tool_name = String(o.tool_name ?? o.tool ?? o.toolName ?? "");
  const ti = o.tool_input ?? o.input ?? o.toolArgs;
  const tool_input = ti && typeof ti === "object" ? (ti as Record<string, unknown>) : {};
  const sid = o.session_id ?? o.sessionId ?? o.conversation_id;
  const sessionId = typeof sid === "string" ? sid : undefined;
  const src = o.source ?? o.agent;
  const source = typeof src === "string" ? src : undefined;
  return { tool_name, tool_input, sessionId, source };
}

// 명령 종류 분류(정규식·본문 미저장) — 반복 낭비 표시용. 확신 없으면 other(추정 승격 금지).
const CMD_TEST = /\b(vitest|jest|mocha|pytest|go test|cargo test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/;
const CMD_BUILD = /\b(tsc\b|next build|vite build|cargo build|go build|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build|make\b)\b/;
const CMD_LINT = /\b(eslint|ruff|flake8|prettier|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint)\b/;
const CMD_INSTALL = /\b((?:npm|pnpm)\s+(?:i|ci|install)\b|yarn(?:\s+install)?\b|pip3?\s+install|cargo add)\b/;
function classifyCmdKind(cmd: string): NonNullable<CaptureRecord["cmdKind"]> {
  if (CMD_TEST.test(cmd)) return "test";
  if (CMD_BUILD.test(cmd)) return "build";
  if (CMD_LINT.test(cmd)) return "lint";
  if (CMD_INSTALL.test(cmd)) return "install";
  return "other";
}

/** 정규화된 envelope(또는 {tool,input}) → CaptureRecord[](없으면 []). 값 미저장. */
export function classifyEvent(payload: unknown, phase: "pre" | "post" | "fail" | "denied" = "post", ts = ""): CaptureRecord[] {
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
      const h = url?.[1];
      const bare = h && h.includes("@") ? h.slice(h.lastIndexOf("@") + 1) : h; // 3R: user:pass@host 의 자격증명(userinfo) 제거 → 평문 비밀의 디스크 저장 방지
      return [{ ...base, op: "network", host: clean(bare) ?? "(unknown-host)" }];
    }
    const dels = extractDeletePaths(cmd);
    if (dels.length) {
      return dels.map((p) => ({ ...base, op: "delete" as const, path: clean(toRel(p)) ?? p }));
    }
    // 반복 탐지용 지문(council 2026-07-03 증분1): 본문은 여전히 미저장 — sha256 16hex(복원 불가)와 종류 분류만.
    const cmdHash = createHash("sha256").update(cmd).digest("hex").slice(0, 16);
    return [{ ...base, op: "command", cmdHash, cmdKind: classifyCmdKind(cmd) }];
  }
  if (tool === "WebFetch") {
    // url 파라미터에서 host 만(값·경로·쿼리 미저장 — Bash network 와 같은 규칙·자격증명 strip 승계).
    const u = String(input.url ?? "");
    const m = u.match(URL_RE);
    const h = m?.[1];
    const bare = h && h.includes("@") ? h.slice(h.lastIndexOf("@") + 1) : h;
    return [{ ...base, op: "network", host: clean(bare) ?? "(unknown-host)" }];
  }
  if (tool === "WebSearch") {
    // 검색어=값이라 저장 금지 — 외부 호출 사실만 고정 표기로 남김.
    return [{ ...base, op: "network", host: "(web-search)" }];
  }
  if (tool === "Task" || tool.startsWith("mcp__")) {
    // 이름만 기록(서브에이전트 생성/MCP 호출이 있었다는 사실) — prompt/인자=값이라 저장 금지. muted(COMMAND_RUN).
    return [{ ...base, op: "command" }];
  }
  return []; // 그 외 도구는 alpha 행위추적 비대상 — COVERED_TOOLS 주석 참고
}

/** records → actions[] + 요약. gitChangedPaths(주입 가능·테스트 결정론) ∩ 행위경로 = gitVisible. */
export function aggregateActions(records: CaptureRecord[], gitChangedPaths: Set<string> = new Set()): ActionsResult {
  const deletes = new Set<string>();
  for (const r of records) if (r.op === "delete" && r.path) deletes.add(r.path);

  const actions: CaptureAction[] = [];
  for (const r of records) {
    if (r.op === "delete" || r.op === "capture-degraded") continue; // delete=write와 합침 / degraded=행위 아닌 갭 마커(영수증 불변)
    let flag: ActionFlag;
    if (r.op === "read") flag = r.path && SECRET_PATH.test(r.path) ? "READ_SECRET_FILE" : "FILE_READ";
    else if (r.op === "network") flag = "EXTERNAL_NETWORK_CALL";
    else if (r.op === "write") flag = r.path && deletes.has(r.path) ? "CREATED_THEN_DELETED" : "FILE_WRITE";
    else flag = "COMMAND_RUN";
    actions.push({ tool: r.tool, op: r.op, path: r.path, host: r.host, flag, ...(r.phase === "fail" ? { failed: true } : {}), ...(r.phase === "denied" ? { denied: true } : {}) });
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

// ── 반복 낭비 분석 (council 2026-07-03 증분1) — 읽기전용·결정론·저장 0(항상 레코드에서 재계산) ──
// 정직 규칙(결정 4): 관측 가능한 횟수만 센다. 토큰/시간 절감 환산·인과 주장 없음. "정상적인 재확인"일 수 있어
// 판단은 사람 몫 — 표시 문구에 반드시 병기. 재독은 *사이에 그 파일 편집(write/delete)이 없을 때만* 반복으로 센다.
export interface WasteSummary {
  rereads: Array<{ path: string; repeats: number }>; // 사이 편집 없는 재독 횟수(첫 읽기 제외)
  repeatedCommands: Array<{ cmdKind: string; count: number }>; // 동일 명령(cmdHash 지문) 2회 이상 실행
  repeatedFailures: Array<{ label: string; count: number }>; // 동일 대상 실패(phase=fail) 2회 이상
}

export function analyzeWaste(records: CaptureRecord[]): WasteSummary {
  // pre+post 이중 기록 dedupe: post 가 하나라도 있으면 post(완료 행위)만, 아니면 pre 만 사용(pre-only 설치 호환).
  const phase = records.some((r) => r.phase === "post") ? "post" : "pre";
  const acts = records.filter((r) => r.phase === phase);

  const sinceWrite = new Map<string, number>();
  const repeats = new Map<string, number>();
  for (const r of acts) {
    if (!r.path) continue;
    if (r.op === "read") {
      const c = (sinceWrite.get(r.path) ?? 0) + 1;
      sinceWrite.set(r.path, c);
      if (c >= 2) repeats.set(r.path, (repeats.get(r.path) ?? 0) + 1);
    } else if (r.op === "write" || r.op === "delete") {
      sinceWrite.set(r.path, 0); // 편집 후 재독은 정상 — 창 리셋
    }
  }

  const byHash = new Map<string, { cmdKind: string; count: number }>();
  for (const r of acts) {
    if (r.op !== "command" || !r.cmdHash) continue;
    const e = byHash.get(r.cmdHash) ?? { cmdKind: r.cmdKind ?? "other", count: 0 };
    e.count += 1;
    byHash.set(r.cmdHash, e);
  }

  const failKey = (r: CaptureRecord): string => `${r.tool} ${r.path ?? r.host ?? (r.cmdHash ? `(command:${r.cmdHash.slice(0, 6)})` : "")}`;
  const fails = new Map<string, number>();
  for (const r of records) {
    if (r.phase !== "fail") continue;
    const k = failKey(r);
    fails.set(k, (fails.get(k) ?? 0) + 1);
  }

  const desc = <T>(arr: T[], by: (t: T) => number): T[] => [...arr].sort((a, b) => by(b) - by(a));
  return {
    rereads: desc([...repeats].map(([path, n]) => ({ path, repeats: n })), (x) => x.repeats),
    repeatedCommands: desc([...byHash.values()].filter((e) => e.count >= 2), (x) => x.count),
    repeatedFailures: desc([...fails].filter(([, n]) => n >= 2).map(([label, count]) => ({ label, count })), (x) => x.count),
  };
}

/** 사람용 표시 줄(없으면 [] → 출력 불변). 상한 5줄/범주 — 장황 리포트 금지(회의 User Advocate). */
export function wasteDisplayLines(w: WasteSummary): string[] {
  const L: string[] = [];
  for (const r of w.rereads.slice(0, 5)) L.push(`같은 파일 재독 ${r.repeats}회 (사이 편집 없음): ${r.path}`);
  for (const c of w.repeatedCommands.slice(0, 5)) L.push(`동일 ${c.cmdKind} 명령 ${c.count}회 실행`);
  for (const f of w.repeatedFailures.slice(0, 5)) L.push(`실패 반복 ${f.count}회: ${f.label}`);
  return L;
}

/** 현 저장소의 capture 로그에서 반복 요약 줄 생성(없으면 []) — insights 등 다른 표면에서 호출. */
export function wasteLinesFromDisk(): string[] {
  try {
    return wasteDisplayLines(analyzeWaste(readRecords()));
  } catch {
    return [];
  }
}

function capFile(): string {
  const root = g.repoRoot() ?? process.cwd();
  return join(root, ".agent-guard", "capture.jsonl");
}

// ── 꼬리 잘림(tail-truncation) 방어 (10차 council) — 봉인사슬이 못 잡는 '맨 끝 N개 삭제'를 high-water-mark 로 탐지 ──
// 사이드카 {count,lastSeq,lastEntryHash}. append *후* 갱신(실패=swallow→head 가 log 보다 뒤처짐=behind=오탐 없음).
// 로컬 best-effort: 공격자가 로그+head 둘 다 일관되게 고치면 우회 가능 — *강한* 꼬리방어는 Rekor 앵커. clear 시 head 도 삭제.
interface CaptureHead {
  count: number;
  lastSeq: number;
  lastEntryHash?: string;
}
function headFile(): string {
  const root = g.repoRoot() ?? process.cwd();
  return join(root, ".agent-guard", "capture.head.json");
}
function readHead(): CaptureHead | null {
  const f = headFile();
  if (!existsSync(f)) return null;
  try {
    const h = JSON.parse(readFileSync(f, "utf8")) as CaptureHead;
    if (h && typeof h.count === "number" && typeof h.lastSeq === "number") return h;
  } catch {
    /* 깨진 head → 없음으로 취급(truncation check 불가·크래시 금지) */
  }
  return null;
}
function writeHead(h: CaptureHead): void {
  try {
    writeFileAtomic(headFile(), JSON.stringify(h) + "\n");
  } catch {
    /* head 갱신 실패 → behind 허용(다음 verify 가 log>=head 로 OK 처리·오탐 없음) */
  }
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
// D4: git 변경 ↔ capture 기록 대사(reconcileCapture)를 Receipt 동결용으로 로드. 기록 없으면 null(=capture 미사용).
export function loadReconciliation(gitChanged: Set<string> = new Set()): ReconResult | null {
  const records = readRecords();
  if (records.length === 0) return null;
  return reconcileCapture(records, gitChanged);
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

// 3R 핫패스 최적화: append 시 전체 파싱(O(n)·세션 누적 O(n^2)) 대신 마지막 유효 레코드만 파싱(체인 prev 권위값=로그 SSOT). count=줄 수(파싱 없음).
function tailRecord(): { lastSeq: number; lastEntryHash?: string; count: number } {
  const f = capFile();
  if (!existsSync(f)) return { lastSeq: 0, count: 0 };
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as CaptureRecord;
      return { lastSeq: r.seq ?? 0, lastEntryHash: r.entryHash, count: lines.length };
    } catch {
      /* 손상 줄이면 이전 줄로(권위 prev=마지막 유효 레코드) */
    }
  }
  return { lastSeq: 0, count: lines.length };
}

// ── 완전성 보증 체인(6차 council iter1) — ledger.ts 의 검증된 해시체인 패턴을 capture 에 이식 ──
// 원칙: entryHash 는 자신을 제외한 결정론 직렬화(prevHash·seq·sessionId 포함) → 변조·삭제·재정렬·중간누락 탐지.
//        새 의존성 0(node crypto). 레거시(체인 없는) 줄은 '검증불가'로 분리(차단 아님).
export function captureEntryHash(r: CaptureRecord): string {
  const o: Record<string, unknown> = {
    ts: r.ts,
    phase: r.phase,
    tool: r.tool,
    op: r.op,
    path: r.path ?? null,
    host: r.host ?? null,
    reason: r.reason ?? null,
    seq: r.seq ?? null,
    sessionId: r.sessionId ?? null,
    prevHash: r.prevHash ?? null,
  };
  if (r.source) o.source = r.source; // 신규 필드는 *있을 때만* 포함 → source 없는 기존 체인 레코드의 해시는 불변.
  if (r.guard) o.guard = r.guard; // 동일 원칙(present-only) — 가드 판정도 변조 탐지 대상에 포함.
  if (r.guardRule) o.guardRule = r.guardRule;
  if (r.cmdHash) o.cmdHash = r.cmdHash;
  if (r.cmdKind) o.cmdKind = r.cmdKind;
  return "sha256:" + createHash("sha256").update(JSON.stringify(o)).digest("hex");
}

/** 분류된 레코드들에 seq/sessionId/source/prevHash/entryHash 를 물려 chain append(append-only). 파일 끝 레코드를 prev 로. */
function appendCapture(recs: CaptureRecord[], sessionId: string | undefined, source?: string): void {
  if (!recs.length) return;
  const f = capFile();
  mkdirSync(dirname(f), { recursive: true });
  // 14차 council: read→chain→append→writeHead 를 락으로 직렬화(병렬 훅 포크=verify 오탐·head 저평가 방지). 못 잡으면 throw → 호출부가 degraded 마커.
  withFileLock(join(dirname(f), "capture.lock"), () => {
    const tail = tailRecord(); // 3R: 전체 파싱 대신 마지막 레코드만(긴 세션 O(n^2) 제거)
    let prevHash = tail.lastEntryHash;
    let seq = tail.lastSeq;
    const lines: string[] = [];
    for (const r of recs) {
      seq += 1;
      const chained: CaptureRecord = { ...r, seq };
      if (sessionId) chained.sessionId = sessionId;
      if (source) chained.source = source;
      if (prevHash) chained.prevHash = prevHash;
      chained.entryHash = captureEntryHash(chained);
      prevHash = chained.entryHash;
      lines.push(JSON.stringify(chained));
    }
    appendFileSync(f, lines.join("\n") + "\n");
    // 꼬리방어: 로그 append *후* high-water-mark 갱신(락 안이라 동시 저평가 없음).
    writeHead({ count: tail.count + recs.length, lastSeq: seq, lastEntryHash: prevHash });
  });
}

/** 순수 검증 코어 — 변조(entryHash 불일치)·삭제/재정렬(prevHash 불연속)·중간누락(seq 불연속) 탐지. 출력/exit 없음. */
export function verifyCaptureChain(records: CaptureRecord[]): CaptureChainResult {
  const problems: string[] = [];
  let verified = 0;
  let legacy = 0;
  let prevEntryHash: string | undefined = undefined;
  let prevSeq: number | undefined = undefined;
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as CaptureRecord;
    const n = i + 1;
    if (!r.entryHash) {
      legacy++;
      prevEntryHash = undefined; // 레거시 줄은 연속성 기준점이 못 됨
      prevSeq = undefined;
      continue;
    }
    if (captureEntryHash(r) !== r.entryHash) {
      problems.push(`#${n} ${r.ts}: entryHash 불일치(레코드 변조 가능)`);
    } else {
      verified++;
    }
    if (prevEntryHash !== undefined && (r.prevHash ?? undefined) !== prevEntryHash) {
      problems.push(`#${n} ${r.ts}: prevHash 가 직전과 불일치(삭제/재정렬 가능)`);
    }
    if (prevSeq !== undefined && r.seq !== undefined && r.seq !== prevSeq + 1) {
      problems.push(`#${n} ${r.ts}: seq 불연속 ${prevSeq}→${r.seq}(중간 누락 가능)`);
    }
    prevEntryHash = r.entryHash;
    prevSeq = r.seq;
  }
  return { problems, verified, legacy };
}

export interface TruncationCheck {
  status: "ok" | "truncation" | "unavailable";
  detail: string;
}
/** 순수: high-water-mark(head) vs 현재 로그 → 꼬리 잘림 탐지. head>log 만 FLAG(behind=정상·오탐 0). head 없음=검사 불가. */
export function checkTruncation(records: CaptureRecord[], head: CaptureHead | null): TruncationCheck {
  if (!head) return { status: "unavailable", detail: "high-water-mark 없음 — 꼬리 삭제 검사 불가" };
  const lastSeq = records.length ? (records[records.length - 1]?.seq ?? 0) : 0;
  if (head.count > records.length || head.lastSeq > lastSeq) {
    return { status: "truncation", detail: `기록부 ${head.count}건/seq ${head.lastSeq} > 로그 ${records.length}건/seq ${lastSeq} — 맨 끝 레코드 삭제(꼬리 잘림) 의심` };
  }
  return { status: "ok", detail: records.length === head.count ? "head=log 일치" : `log ${records.length} >= head ${head.count}(head 뒤처짐·정상)` };
}

// ── 대사 (reconciliation·11차 council) — 두 독립기록(git 변경 ↔ capture 기록) 교차대조 + 잔차 강제 분류 ──
// 회계 대사처럼 잔차를 표시만 말고 분류한다. 🔴 자동 cleared 금지: capture 가 *확실히* 본 것만 설명, 나머지는 unexplained 로 남김(거짓 안심 차단).
//   '서브에이전트라서' 같은 추정 라벨은 붙이지 않는다(우리 데이터로 확정 못 함 — 일반 caveat 로만).
export type ReconReason = "captured-read-or-delete-only" | "unexplained";
export interface ReconResidual {
  path: string;
  reason: ReconReason;
}
export interface ReconResult {
  matched: number; // git 변경 ↔ capture write 일치
  residuals: ReconResidual[]; // git 변경인데 capture write 기록 없음
  unexplained: number; // 그중 capture 가 전혀 못 본 것(진짜 갭)
  capturedNotInGit: number; // capture write 인데 git 효과 없음(생성후삭제/임시 등)
}
export function reconcileCapture(records: CaptureRecord[], gitChanged: Set<string>): ReconResult {
  const writePaths = new Set<string>();
  const otherPaths = new Set<string>(); // read/delete 로 본 경로
  for (const r of records) {
    if (r.op === "capture-degraded" || !r.path) continue;
    if (r.op === "write") writePaths.add(r.path);
    else otherPaths.add(r.path);
  }
  const residuals: ReconResidual[] = [];
  for (const p of gitChanged) {
    if (writePaths.has(p)) continue; // 일치 — 설명됨
    residuals.push({ path: p, reason: otherPaths.has(p) ? "captured-read-or-delete-only" : "unexplained" });
  }
  return {
    matched: [...gitChanged].filter((p) => writePaths.has(p)).length,
    residuals,
    unexplained: residuals.filter((r) => r.reason === "unexplained").length,
    capturedNotInGit: [...writePaths].filter((p) => !gitChanged.has(p)).length,
  };
}

/** 실패를 조용히 삼키지 않고 'capture-degraded' 마커를 체인에 남긴다(비차단 exit 0). 마커 기록조차 실패하면 조용히 통과. */
function markDegraded(phase: "pre" | "post" | "fail" | "denied", ts: string, reason: string): never {
  try {
    appendCapture([{ ts, phase, tool: "(capture)", op: "capture-degraded", reason }], undefined);
  } catch {
    /* 마커 기록 실패 시에도 비차단(증거지 게이트 아님) */
  }
  process.exit(0);
}

/** `agent-receipt capture [--event pre|post]` — 훅 stdin(JSON) 1건을 분류·마스킹·체인 append. 항상 통과(비차단). */
export function runCaptureIngest(event: string | undefined): never {
  // 명시 파싱(Phase9): 미지 이벤트를 post 로 강하시키면 "실패/거부가 성공으로 오기록"되는 함정(fail 때 실증) —
  // 이제 미지 값은 degraded 갭 마커로 남긴다(사라짐 아님·오기록 아님·DA③ 수용).
  const KNOWN = { pre: "pre", post: "post", fail: "fail", denied: "denied" } as const;
  const phase: "pre" | "post" | "fail" | "denied" | undefined = KNOWN[event as keyof typeof KNOWN];
  if (event !== undefined && phase === undefined) markDegraded("post", new Date().toISOString(), `unknown-event:${String(event).slice(0, 20)}`);
  const ph = phase ?? "post";
  if (process.stdin.isTTY) process.exit(0); // 파이프 입력 없으면 무동작(실패 아님)
  const now = new Date().toISOString();
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    markDegraded(ph, now, "stdin 읽기 실패");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    markDegraded(ph, now, "stdin JSON 파싱 실패");
  }
  // 7차 council: 벤더중립 정규화 토대 — 다양한 에이전트 envelope 를 공통 모양으로(추정 0·passthrough+단순 alias).
  const env = normalizeEnvelope(payload);
  const recs = classifyEvent(env, phase, now);
  // ── 실시간 가드(council 2026-07-03·스모크 4/4): pre 단계 write/delete 만 대조. 기록이 먼저, deny 방출은 그 다음(증거 우선). ──
  let denyReason: string | undefined;
  if (ph === "pre") {
    for (const r of recs) {
      const v = evalGuard(r);
      if (v.action === "none") continue;
      r.guard = v.action === "deny" ? "deny" : "warn";
      if (v.rule) r.guardRule = `${v.origin}:${v.rule}`;
      if (v.action === "deny" && !denyReason) denyReason = v.reason;
    }
  }
  if (recs.length) {
    try {
      appendCapture(recs, env.sessionId, env.source);
    } catch {
      markDegraded(ph, now, "capture 락 획득 실패(동시 훅 경합 또는 stale)"); // 정직 마커(비차단)·silent 누락 금지
    }
  }
  if (denyReason) {
    // Claude Code PreToolUse 훅 계약(2026-07-03 헤드리스 스모크 실측): stdout 의 permissionDecision=deny →
    // 도구 미실행 + 이유가 에이전트에 노출 + 재시도 없이 진행. 기록 실패와 무관하게 차단은 유지(위 markDegraded 가 갭 증거).
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: denyReason },
      }),
    );
  }
  process.exit(0);
}

/** `agent-receipt capture show [--json]` — 누적 capture.jsonl 집계 출력(데모 핵심: git:N ⟷ 행위:M). */
export function runCaptureShow(json: boolean): never {
  const records = readRecords();
  const gitChanged = new Set<string>(
    [...safeList(g.unstagedFiles), ...safeList(g.stagedFiles), ...safeList(g.untrackedFiles)].filter(
      (p) => !isToolOutput(p), // 3R: 도구 자기 산출물(.agent-guard/capture.jsonl 등)을 'git 변경'으로 오귀속 안 함(거짓 잔차/거짓 경보 방지)
    ),
  );
  const result = aggregateActions(records, gitChanged);
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  }
  const s = result.actionsSummary;
  const { notable, mutedCount } = splitActionsForDisplay(result.actions);
  console.log(`\nagent-receipt capture (alpha) — git 너머 행위 ${s.total}건 (주목 ${notable.length})`);
  for (const a of notable) console.log(`  ⚠️ ${a.flag}  ${a.path ?? a.host ?? ""}${a.failed ? "  (실패 시도)" : ""}${a.denied ? "  (권한 거부됨)" : ""}`);
  if (mutedCount) console.log(`  · 그 외 일반 read/command ${mutedCount}건 (기록됨·접힘)`);
  console.log(`\n  git 가 보는 것: ${s.gitVisible}  ⟷  주목 행위: ${notable.length}  (전체 기록 ${s.total})`);
  const guardDeny = records.filter((r) => r.guard === "deny").length;
  const guardWarn = records.filter((r) => r.guard === "warn").length;
  if (guardDeny || guardWarn) console.log(`  가드(금지 경로 쓰기): 차단 ${guardDeny} · 경고 ${guardWarn} — 근거는 capture.jsonl guardRule`); // present-only(없으면 출력 불변)
  const wasteL = wasteDisplayLines(analyzeWaste(records));
  if (wasteL.length) {
    console.log(`\n  반복(참고 — 정상적인 재확인일 수 있음·판단은 사람 몫):`); // present-only·환산/인과주장 없음(council 결정 4)
    for (const l of wasteL) console.log(`   · ${l}`);
  }
  // 대사(11차 council): git 변경 ↔ capture write 교차대조 + 잔차 분류(자동 cleared 금지·미설명은 남김).
  const recon = reconcileCapture(records, gitChanged);
  const degraded = records.filter((r) => r.op === "capture-degraded").length;
  if (recon.residuals.length) {
    console.log(`\n  대사(reconciliation) — git 변경 ↔ capture: 일치 ${recon.matched} · 잔차 ${recon.residuals.length}(미설명 ${recon.unexplained})`);
    for (const r of recon.residuals.slice(0, 10)) {
      const tag = r.reason === "unexplained" ? "미설명(capture 기록 0)" : "읽기/삭제만 포착(write 기록 없음)";
      console.log(`     ✗ ${r.path}  — ${tag}`);
    }
    if (recon.residuals.length > 10) console.log(`     … 외 ${recon.residuals.length - 10}건`);
    console.log(`     ⓘ 미설명 잔차는 자동 해소하지 않습니다 — 훅 미커버(서브에이전트/MCP/OS) 또는 진짜 누락일 수 있음(직접 확인).`);
  } else {
    console.log(`\n  대사 OK — git 변경이 전부 capture write 와 일치(잔차 0).`);
  }
  if (recon.capturedNotInGit) console.log(`  · capture write ${recon.capturedNotInGit}건은 git 효과 없음(생성후삭제/임시 가능).`);
  if (degraded) console.log(`  ⚠️ capture 열화 마커 ${degraded}건 — 일부 행위 기록 실패(조용한 누락 아님).`);
  console.log(`\n  커버 도구: ${COVERED_TOOLS.join(", ")} (그 외 WebFetch·MCP·Task·OS레벨은 capture 범위 밖).`);
  console.log(`  tamper-evident & gap-evident — '설정된 훅 표면' 한정(complete/빠짐없음 아님). 'capture verify' 로 체인 검증.`);
  console.log(`  값은 저장하지 않습니다 — 경로/호스트/행위분류만. ${REDACT_NOTE}`);
  process.exit(0);
}

/** `agent-receipt capture verify` — capture.jsonl 해시체인 검증(read-only). 변조·삭제/재정렬·중간누락 탐지. 레거시 줄은 검증불가(차단 아님). */
export function runCaptureVerify(): never {
  const records = readRecords();
  const { problems, verified, legacy } = verifyCaptureChain(records);
  const trunc = checkTruncation(records, readHead());
  console.log(`\nagent-receipt capture verify — ${records.length}건 (검증 ${verified} · 레거시 ${legacy} · 문제 ${problems.length})`);
  if (problems.length) for (const p of problems) console.log(`  ✗ ${p}`);
  else console.log(legacy ? "  체인 OK ✅ (레거시 줄은 검증 대상 아님)" : "  체인 OK ✅");
  if (trunc.status === "truncation") console.log(`  ✗ 꼬리 잘림: ${trunc.detail}`);
  else if (trunc.status === "unavailable") console.log(`  · 꼬리 검사: ${trunc.detail}`);
  else console.log(`  꼬리 검사 OK ✅ (${trunc.detail})`);
  console.log("  tamper-evident & gap-evident — 설정된 훅 표면 한정(complete 아님; 미설치·--dangerously-skip-permissions·subagent/MCP/pipe·OS레벨은 범위 밖).");
  console.log("  꼬리방어 high-water-mark 는 로컬 best-effort(로그+head 둘 다 일관 변조 시 우회 가능) — 강한 꼬리방어는 'anchor'(Rekor 제3자 봉인).");
  process.exit(problems.length || trunc.status === "truncation" ? 1 : 0);
}

/** capture 로그를 조용히 비운다(비exit·무출력) — begin(새 baseline)/reset 에서 재사용. council A #1. */
export function clearCaptureLog(): void {
  for (const f of [capFile(), headFile()]) {
    // 로그·head 동시 삭제 — 한쪽만 남으면 head>log 오탐(10차 council).
    try {
      if (existsSync(f)) rmSync(f);
    } catch {
      /* noop */
    }
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
// matcher 파생(단일 출처 COVERED_TOOLS): `mcp__*` 표기는 regex `mcp__.*` 로 변환.
// `.` 이 들어가는 순간 matcher 전체가 regex 경로(unanchored test·공식 문서 실측)가 되므로
// `^(...)$` 로 명시 anchor — unanchored "Read" 가 임의 신규 도구명에 부분매칭하는 사고 방지.
const HOOK_MATCHER = `^(${COVERED_TOOLS.map((t) => (t === "mcp__*" ? "mcp__.*" : t)).join("|")})$`;
const captureCommand = (phase: "pre" | "post" | "fail" | "denied"): string => `agent-receipt capture --event ${phase}`;

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
  const phases: Array<["PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionDenied", "pre" | "post" | "fail" | "denied"]> = [
    ["PreToolUse", "pre"],
    ["PostToolUse", "post"],
    // 도구 실패도 사실(시도) — 문서 실측: 비차단 이벤트·tool_name/tool_input 공통형만 읽음(에러 텍스트=값·미저장).
    ["PostToolUseFailure", "fail"],
    // 권한 거부된 시도도 사실(Phase9) — 문서의 tool-events 목록에 PermissionDenied 실재(같은 tool_name 매칭).
    ["PermissionDenied", "denied"],
  ];
  for (const [key, phase] of phases) {
    const cmd = captureCommand(phase);
    const arr: HookEntry[] = Array.isArray(merged.hooks[key]) ? merged.hooks[key] : [];
    const ours = arr.find((e) => Array.isArray(e?.hooks) && e.hooks.some((h) => h?.command === cmd));
    if (!ours) {
      arr.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: cmd }] });
      changed = true;
    } else if (ours.matcher !== HOOK_MATCHER) {
      // 커버 도구가 늘면 matcher 도 따라와야 함 — 안 고치면 옛 matcher 가 영구 박제(확장이 기존 설치본에 영원히 미적용되는 실버그·Phase6 수리).
      ours.matcher = HOOK_MATCHER;
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
