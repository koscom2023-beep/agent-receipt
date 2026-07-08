import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionData } from "./start.js";
import * as g from "./git.js";

// verify 가 노이즈에서 제외할 자기 제어 파일 — session.json "만"(.agent-guard/** 전체 제외 아님).
export const SESSION_REL_PATH = ".agent-guard/session.json";

// verify/evidence 가 "사용자 작업물 아님"으로 제외하는 tool 산출물 집합(단일 출처).
//   session.json · receipts/ · keys/ · dashboard.html · audit-packs/ · ledger.jsonl · notes/ · decisions/(0.9)
//   + .agent-guard/ 아래 *.sig.json / *.approval.json 사이드카(0.9.1: 경로 무관 명시 — 도구가 만든 서명/승인 증거).
// contract.yaml / policy.yaml / README.md 는 사용자가 커밋할 실제 파일이므로 제외하지 않는다(.agent-guard/** 전체 제외 아님).
export function isToolOutput(f: string): boolean {
  return (
    f === SESSION_REL_PATH ||
    f.startsWith(".agent-guard/receipts/") ||
    f.startsWith(".agent-guard/keys/") ||
    f.startsWith(".agent-guard/audit-packs/") ||
    f.startsWith(".agent-guard/notes/") ||
    f.startsWith(".agent-guard/decisions/") ||
    f === ".agent-guard/ledger.jsonl" ||
    f === ".agent-guard/dashboard.html" ||
    f === ".agent-guard/capture.jsonl" ||
    f === ".agent-guard/capture.head.json" ||
    f.startsWith(".agent-guard/tap/") || // mcp-tap 로그·커서·sidecar(자기 장부 오탐 방지 — 0.11.2 계열 선례)

    f.startsWith(".agent-guard/anchors/") ||
    (f.startsWith(".agent-guard/proof-") && f.endsWith(".html")) ||
    (f.startsWith(".agent-guard/") && (f.endsWith(".sig.json") || f.endsWith(".approval.json")))
  );
}

// .agent-guard/session.json 을 읽는다. 없거나 형식이 깨졌으면 null(=baseline 미적용 → v0.1 동작).
export function loadSession(cwd: string = process.cwd()): SessionData | null {
  const p = join(cwd, ".agent-guard", "session.json");
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { baselineHead?: unknown }).baselineHead === "string"
    ) {
      return data as SessionData;
    }
    return null;
  } catch {
    return null;
  }
}

export type ResolvedSession =
  | { applied: true; session: SessionData; reason: null }
  | { applied: false; session: SessionData | null; reason: string | null };

/**
 * session 유효성 판정. 유효하면 baseline 적용, 무효면 무시(full-tree degrade — 안전 방향).
 *  - branch 불일치  → 무시
 *  - baselineHead 가 현재 HEAD 의 조상이 아님(rebase/checkout) → 무시
 */
export function resolveSession(cwd: string = process.cwd()): ResolvedSession {
  const session = loadSession(cwd);
  if (!session) return { applied: false, session: null, reason: null };
  if (session.gitBranch !== g.currentBranch()) {
    return { applied: false, session, reason: "branch-mismatch" };
  }
  if (!g.isAncestor(session.baselineHead, "HEAD")) {
    return { applied: false, session, reason: "baseline-not-ancestor" };
  }
  return { applied: true, session, reason: null };
}
