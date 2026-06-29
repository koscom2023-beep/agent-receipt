import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
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

// 비밀로 취급하는 경로(읽기 시 READ_SECRET_FILE). 경로 '이름'만 봄(내용 아님).
const SECRET_PATH = /(^|\/)\.env(\.|$|\b)|\.(key|pem|p12|pfx|keystore)$|(^|\/)(id_rsa|id_ed25519|id_dsa)$|secret|credential/i;
const NET_CMD = /\b(curl|wget|nc|ncat|telnet)\b/;
const URL_RE = /https?:\/\/([^/\s'"]+)/i;
const RM_RE = /\brm\b\s+(?:-[a-zA-Z]+\s+)*['"]?([^\s'"|;&]+)/;

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

/** Claude Code 훅 payload(또는 {tool,input}) → 정규화된 CaptureRecord(없으면 null). 값 미저장. */
export function classifyEvent(payload: unknown, phase: "pre" | "post" = "post", ts = ""): CaptureRecord | null {
  const o = payload as { tool_name?: string; tool?: string; tool_input?: Record<string, unknown>; input?: Record<string, unknown> };
  const tool = String(o?.tool_name ?? o?.tool ?? "");
  if (!tool) return null;
  const input = (o?.tool_input ?? o?.input ?? {}) as Record<string, unknown>;
  const base = { ts, phase, tool };
  const fp = () => clean(toRel(String(input.file_path ?? input.notebook_path ?? input.path ?? "")));

  if (tool === "Read" || tool === "NotebookRead") {
    const path = fp();
    return path ? { ...base, op: "read", path } : null;
  }
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = fp();
    return path ? { ...base, op: "write", path } : null;
  }
  if (tool === "Bash") {
    const cmd = String(input.command ?? input.cmd ?? "");
    const url = cmd.match(URL_RE);
    if (url || NET_CMD.test(cmd)) {
      return { ...base, op: "network", host: clean(url?.[1]) ?? "(unknown-host)" };
    }
    const rm = cmd.match(RM_RE);
    if (rm && rm[1]) {
      const path = clean(toRel(rm[1]));
      return path ? { ...base, op: "delete", path } : null;
    }
    return { ...base, op: "command" };
  }
  return null; // 그 외 도구는 alpha 행위추적 비대상
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
  const rec = classifyEvent(payload, phase, new Date().toISOString());
  if (rec) {
    const f = capFile();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(rec) + "\n");
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
  console.log(`\nagent-receipt capture (alpha) — git 너머 행위 ${s.total}건`);
  for (const a of result.actions) console.log(`  ⚠️ ${a.flag}  ${a.path ?? a.host ?? ""}`);
  console.log(`\n  git 가 보는 것: ${s.gitVisible}  ⟷  영수증이 본 행위: ${s.total}`);
  console.log(`  값은 저장하지 않습니다 — 경로/호스트/행위분류만. ${REDACT_NOTE}`);
  process.exit(0);
}

/** `agent-receipt capture reset` — 캡처 로그 초기화(새 세션 시작용). */
export function runCaptureReset(): never {
  const f = capFile();
  try {
    if (existsSync(f)) rmSync(f);
  } catch {
    /* noop */
  }
  console.log("capture 로그 초기화됨.");
  process.exit(0);
}
