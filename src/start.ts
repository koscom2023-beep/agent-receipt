import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchGlob } from "./pathmatch.js";
import type { Contract } from "./schema.js";
import * as g from "./git.js";

// start 전용 glob 매칭(checks.ts 와 동일 규칙 — 결합 회피용 로컬 복제).
function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(file, p));
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

// 0.9: 작업 종류(kind) — begin --kind 로 기록. session.json·receipt sidecar 에만(verify --json 14키 비접촉).
export const SESSION_KINDS = [
  "recon",
  "implementation",
  "docs",
  "test",
  "measure-first",
  "observe-only",
  "release-check",
] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

// .agent-guard/session.json 의 baseline 스키마(계약 스키마와 무관 — 독립 버전).
export interface SessionData {
  version: 1;
  baselineHead: string;
  createdAt: string;
  contractId: string;
  gitBranch: string;
  kind?: SessionKind; // 0.9 optional — 없으면 기존 동작(하위호환)
  objective?: string; // 배치A-6 optional — 세션 목적(자가보고·미검증 — GitLab 3질문의 ② "뭘 하려던 것이었나" 기록)
  unstagedAtStart: string[];
  stagedAtStart: string[];
  untrackedAtStart: string[];
}

export type StartResult =
  | { ok: true; created: true; session: SessionData; message: string }
  | { ok: false; created: false; reason: "denied-dirty" | "exists"; message: string };

// ── 비-exit 코어: baseline 기록 시도. begin/orchestrator 재사용. 안전조건 둘은 그대로(차단). ──
export function startCore(contract: Contract, cwd: string = process.cwd(), kind?: SessionKind, objective?: string): StartResult {
  const unstaged = g.unstagedFiles();
  const staged = g.stagedFiles();
  const untracked = g.untrackedFiles();
  const touched = unique([...unstaged, ...staged, ...untracked]);

  // 안전조건 1: denied 경로가 이미 dirty 면 baseline 으로 묻지 않는다.
  const deniedDirty = touched.filter((f) => matchesAny(f, contract.scope.denied_paths));
  if (deniedDirty.length) {
    return {
      ok: false,
      created: false,
      reason: "denied-dirty",
      message:
        "start 중단: denied_paths 에 걸리는 변경이 이미 있습니다 (baseline 으로 묻지 않습니다):\n" +
        deniedDirty.map((f) => `  - ${f}`).join("\n") +
        "\n해결: 위 파일을 정리(되돌리기/commit/gitignore)하거나, 계약의 denied_paths 글롭을 좁힌 뒤 다시 'agent-receipt start'.",
    };
  }

  const dir = join(cwd, ".agent-guard");
  const sessionPath = join(dir, "session.json");

  // 안전조건 2: 기존 baseline 을 덮어쓰지 않는다.
  if (existsSync(sessionPath)) {
    return {
      ok: false,
      created: false,
      reason: "exists",
      message:
        "start 중단: 이미 baseline(.agent-guard/session.json)이 있습니다. 새로 찍으려면 먼저 'agent-receipt reset' 으로 제거하세요.",
    };
  }

  const session: SessionData = {
    version: 1,
    baselineHead: g.headHash(),
    createdAt: new Date().toISOString(),
    contractId: contract.id,
    gitBranch: g.currentBranch(),
    ...(kind ? { kind } : {}),
    ...(objective ? { objective } : {}), // 자가보고 — 값은 기록만(검증 아님)
    unstagedAtStart: unstaged,
    stagedAtStart: staged,
    untrackedAtStart: untracked,
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath, JSON.stringify(session, null, 2) + "\n");

  return {
    ok: true,
    created: true,
    session,
    message:
      `baseline 기록됨 (contract: ${session.contractId}, branch: ${session.gitBranch}${kind ? `, kind: ${kind}` : ""}):\n` +
      "  - .agent-guard/session.json\n" +
      `  - baselineHead: ${session.baselineHead}\n` +
      `  - snapshot: unstaged ${unstaged.length}, staged ${staged.length}, untracked ${untracked.length}`,
  };
}

/**
 * `agent-guard start` — 작업 시작 시점의 git 상태를 .agent-guard/session.json 에 baseline 으로 저장.
 * 안전 규칙(둘 다 baseline 을 찍지 않고 실패): denied dirty / 기존 session 존재.
 * verify 동작은 바꾸지 않는다(baseline 적용은 별도 단계). 항상 process.exit 로 끝난다.
 */
export function runStart(contract: Contract, kind?: SessionKind): never {
  const res = startCore(contract, process.cwd(), kind);
  if (!res.ok) {
    console.error(res.message);
    process.exit(1);
  }
  console.log(res.message);
  process.exit(0);
}
