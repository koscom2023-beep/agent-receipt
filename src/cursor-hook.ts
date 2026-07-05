/**
 * Cursor IDE 훅 stdin → agent-receipt capture 공통 envelope.
 * 경로·도구명은 Cursor 공식 hooks 문서 + ~/.cursor-hook-probe/payloads.jsonl 실측으로만 확장(추정 0).
 */

/** Cursor preToolUse matcher 표기(Shell) → capture 분류기(Bash). 문서 실측 alias 만. */
export const CURSOR_TOOL_ALIASES: Record<string, string> = {
  Shell: "Bash",
};

/** WSL UNC·file URI → posix (Cursor on Windows → repo 상대 toRel 입력용). */
export function normalizeAgentPath(raw: string): string {
  let p = raw.trim();
  if (!p) return p;
  const fileUri = /^file:\/\/\/wsl(?:\.localhost|\$)\/[^/]+\/(.*)$/i.exec(p.replace(/\\/g, "/"));
  if (fileUri) return `/${fileUri[1]}`;
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/i.exec(p);
  if (unc) {
    const rest = unc[1].replace(/\\/g, "/");
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return p.replace(/\\/g, "/");
}

// JSON 문자열에서 백슬래시 뒤 올 수 있는 유효 이스케이프 문자(RFC 8259).
const VALID_JSON_ESCAPE = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/**
 * 손상된 훅 payload 를 복구해 파싱 가능한 JSON 문자열로 만든다 — **엄격 파싱 실패 시에만** 쓰는 폴백.
 *
 * 실측 배경(2026-07-03): Cursor(Windows)→wsl.exe→probe stdin 전송 계층이 payload 를 손상시킨다 —
 *   ①선두 UTF-8 BOM ②CRLF ③비-ASCII(한글 사용자명 등) 코드페이지 손상에 딸려 온 **홑 백슬래시**
 *   (예: `transcript_path`="C:\Users\…" — 우리가 안 쓰는 필드인데 JSON.parse 를 통째로 죽인다).
 *
 * 원칙: **이스케이프 상태기계**로 이미 유효한 이스케이프(`\" \\ \/ \b \f \n \r \t \uXXXX`)는 절대 건드리지
 *   않는다 → 우리가 실제 쓰는 필드(file_path 등·Cursor 가 이미 `\\` 로 정상 이스케이프)는 byte-불변.
 *   오직 *문자열 안의 홑 백슬래시* 와 *문자열 안 raw 개행* 만 이스케이프 보정한다.
 */
export function sanitizeLooseJson(raw: string): string {
  const s = raw.replace(/^﻿/, "");
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      out += c;
      if (c === '"') inStr = true;
      continue;
    }
    // 문자열 내부
    if (c === "\\") {
      const n = s[i + 1];
      if (n !== undefined && VALID_JSON_ESCAPE.has(n)) {
        out += c + n; // 유효 이스케이프 — 원본 그대로 통과(다음 문자 소비)
        i++;
      } else {
        out += "\\\\"; // 홑 백슬래시 → 이스케이프 복구(안 쓰는 필드의 Windows 경로 등)
      }
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = false;
      continue;
    }
    if (c === "\r" || c === "\n") {
      out += c === "\r" ? "\\r" : "\\n"; // 문자열 내 raw 개행 → 이스케이프(구조 밖 개행은 JSON.parse 가 허용)
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 훅 stdin 원문 → payload. 엄격 파싱 우선(클린 payload 는 byte-불변) → 실패 시에만 sanitize 복구 후 재파싱.
 * 둘 다 실패면 던진다(호출부가 degraded 로 기록).
 */
export function parseHookStdin(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(sanitizeLooseJson(raw)); // 실패 시 재던짐 → 호출부 degrade
  }
}

/** 선두 UTF-8 BOM 1회 제거 — 훅 stdin 의 유일 승인 정규화(capture 진입점과 동일 규칙). 내용 불변. */
export function stripLeadingBom(raw: string): string {
  return raw.replace(/^﻿/, "");
}

/** inspectHookParse 결과 — 진단/게이트(D4)용. */
export interface HookParseReport {
  ok: boolean; // 최종적으로 파싱됐나
  usedFallback: boolean; // BOM 스트립 후 엄격 파싱이 실패해 sanitize 폴백이 필요했나
  hadBom: boolean;
  hadCr: boolean;
}

/**
 * 진단 전용(비-핫패스): 훅 stdin 원문이 **BOM 스트립 후 엄격 파싱 첫 시도**로 사는지, 아니면
 * sanitizeLooseJson 폴백이 필요한지 계측한다. parseHookStdin 의 동작을 바꾸지 않는다(순수·관측만).
 * 게이트(c) 재정의="BOM 스트립 후 폴백 없이 엄격 파싱"의 자동 판정에 쓴다.
 */
export function inspectHookParse(raw: string): HookParseReport {
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const hadCr = raw.includes("\r");
  const stripped = stripLeadingBom(raw);
  try {
    JSON.parse(stripped);
    return { ok: true, usedFallback: false, hadBom, hadCr };
  } catch {
    try {
      JSON.parse(sanitizeLooseJson(raw));
      return { ok: true, usedFallback: true, hadBom, hadCr };
    } catch {
      return { ok: false, usedFallback: true, hadBom, hadCr };
    }
  }
}

function pickPath(o: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  const candidates = [
    input.file_path,
    input.path,
    input.filePath,
    o.file_path,
    o.path,
    o.filePath,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return normalizeAgentPath(c);
  }
  return undefined;
}

function pickCommand(input: Record<string, unknown>): string | undefined {
  const c = input.command ?? input.cmd ?? input.shellCommand;
  return typeof c === "string" ? c : undefined;
}

/**
 * Cursor 전용·혼합 envelope 를 normalizeEnvelope 입력 형태로. 미지원이면 null(원본 normalizeEnvelope 유지).
 */
export function adaptCursorHookPayload(payload: unknown): Record<string, unknown> | null {
  const o = (payload ?? {}) as Record<string, unknown>;
  const event = String(o.hook_event_name ?? o.hookEventName ?? "");
  const ti = o.tool_input ?? o.input ?? o.toolArgs;
  const tool_input = ti && typeof ti === "object" ? { ...(ti as Record<string, unknown>) } : {};
  let tool_name = String(o.tool_name ?? o.tool ?? o.toolName ?? "");

  if (!tool_name && (event === "afterFileEdit" || event === "afterTabFileEdit")) {
    const fp = pickPath(o, tool_input);
    if (fp) {
      return {
        tool_name: "Write",
        tool_input: { file_path: fp },
        conversation_id: o.conversation_id,
        source: "cursor",
      };
    }
  }

  if (!tool_name) return null;

  const mapped = CURSOR_TOOL_ALIASES[tool_name] ?? tool_name;
  const fp = pickPath(o, tool_input);
  if (fp) tool_input.file_path = fp;
  const cmd = pickCommand(tool_input);
  if (cmd && !tool_input.command) tool_input.command = cmd;

  const out: Record<string, unknown> = {
    tool_name: mapped,
    tool_input,
    source: "cursor",
  };
  if (typeof o.conversation_id === "string") out.conversation_id = o.conversation_id;
  if (typeof o.sessionId === "string") out.sessionId = o.sessionId;
  return out;
}
