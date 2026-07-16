import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionData } from "./start.js";
import * as g from "./git.js";

// 경로 분류(isToolOutput 등)는 agentguard.ts 가 단일 원천이다. 소비자는 그쪽에서 직접 가져간다.
// 여기서 다시 정의하지도, 우회 통로로 다시 내보내지도 않는다(두 입구가 생기면 판정이 갈린다).

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
