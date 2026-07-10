import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { matchGlob } from "./pathmatch.js";
import type { Contract } from "./schema.js";
import * as g from "./git.js";
import { resolveSession, isToolOutput } from "./session.js";

export type CommandResult = {
  name: string;
  command: string;
  exitCode: number;
  requiredExit: number;
  ok: boolean;
  env: boolean; // exit 127 = command not found / 환경 문제(코드 실패와 구분 — 표시 전용)
};

export type VerifyResult = {
  contractId: string;
  title?: string;
  branch: { current: string; expected?: string; ok: boolean };
  touched: string[];
  staged: string[];
  untracked: string[];
  outOfScope: string[];
  deniedHits: string[];
  stagedOutOfScope: string[];
  nulPaths: string[];
  nulBad: string[];
  commands: CommandResult[];
  headHash: string;
  aheadBehind: { ahead: number; behind: number } | null;
  violations: string[];
  ok: boolean;
};

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(file, p));
}

function unique(arr: string[]): string[] {
  return [...new Set(arr)];
}

function runCommand(name: string, command: string, requiredExit: number): CommandResult {
  let exitCode = 0;
  try {
    execSync(command, { stdio: "inherit" });
  } catch (e: any) {
    exitCode = typeof e?.status === "number" ? e.status : 1;
  }
  // exit 127 = 셸의 "command not found" 관례 → 코드 실패가 아니라 환경 문제로 구분(판정/exit 규칙은 불변).
  return { name, command, exitCode, requiredExit, ok: exitCode === requiredExit, env: exitCode === 127 };
}

// opts.committedBase: 커밋-모드(post-commit 증거). 지정 시 작업트리 대신 committedBase..HEAD
// 커밋 변경만 측정한다(scope/denied/critical 모두 그 커밋 파일 집합 기준). 미지정=기존 동작(바이트 동일).
export function runVerify(contract: Contract, opts: { committedBase?: string } = {}): VerifyResult {
  const violations: string[] = [];

  // 1) 브랜치 확인
  const current = g.currentBranch();
  const expected = contract.branch?.expected;
  const branchOk = !expected || expected === current;
  if (!branchOk) {
    violations.push(`브랜치 불일치: 현재 '${current}', 계약은 '${expected}'`);
  }

  // 2) AI가 건드린 파일 모으기.
  //    제어 파일 .agent-guard/session.json 은 항상 제외(전체 .agent-guard/** 제외는 아님).
  //    유효 session(baseline) 이 있으면 scope 검사는 baseline 이후 신규 변경만 본다.
  //    denied 검사는 안전을 위해 항상 full touched 기준(baseline 으로 절대 안 묻음).
  // 제어/산출 파일은 verify 에서 제외(session.json/receipts/keys/dashboard.html — session.ts isToolOutput).
  // contract.yaml/README.md 는 사용자 파일이라 제외 안 함.
  const ex = (arr: string[]): string[] => arr.filter((f) => !isToolOutput(f));
  const curUnstaged = ex(g.unstagedFiles());
  const curStaged = ex(g.stagedFiles());
  const curUntracked = ex(g.untrackedFiles());

  const sess = resolveSession();
  const notInSnap = (snap: string[]) => (f: string): boolean => !snap.includes(f);

  let unstaged: string[];
  let staged: string[];
  let untracked: string[];
  let committed: string[] = [];
  if (opts.committedBase !== undefined) {
    // 커밋-모드: 작업트리 무시, committedBase..HEAD 커밋 변경만 측정(post-commit 증거).
    unstaged = [];
    staged = [];
    untracked = [];
    committed = ex(g.committedSince(opts.committedBase));
  } else if (sess.applied) {
    const s = sess.session;
    unstaged = curUnstaged.filter(notInSnap(s.unstagedAtStart));
    staged = curStaged.filter(notInSnap(s.stagedAtStart));
    untracked = curUntracked.filter(notInSnap(s.untrackedAtStart));
    committed = ex(g.committedSince(s.baselineHead));
  } else {
    unstaged = curUnstaged;
    staged = curStaged;
    untracked = curUntracked;
  }

  // scope 검사 기준(baseline-relative) / denied 검사 기준(full).
  // 커밋-모드에선 denied/critical 도 커밋 파일 집합 기준(작업트리로 안 묻음).
  const touched = unique([...unstaged, ...staged, ...untracked, ...committed]);
  const touchedFull = opts.committedBase !== undefined ? touched : unique([...curUnstaged, ...curStaged, ...curUntracked]);

  const allowed = contract.scope.allowed_paths;
  const denied = contract.scope.denied_paths;

  // 3) 허용 목록 밖 변경 (baseline-relative)
  const outOfScope = allowed.length ? touched.filter((f) => !matchesAny(f, allowed)) : [];
  if (outOfScope.length) {
    violations.push(`허용 범위 밖 변경 ${outOfScope.length}건: ${outOfScope.join(", ")}`);
  }

  // 4) 금지 목록에 닿은 변경 (full touched — baseline 으로 안 묻음)
  const deniedHits = touchedFull.filter((f) => matchesAny(f, denied));
  if (deniedHits.length && contract.git.require_no_denied_path_diff) {
    violations.push(`금지 파일 변경 ${deniedHits.length}건: ${deniedHits.join(", ")}`);
  }

  // 5) 허용 밖 파일이 stage됨 (baseline-relative)
  const stagedOutOfScope = allowed.length ? staged.filter((f) => !matchesAny(f, allowed)) : [];
  if (stagedOutOfScope.length && contract.git.require_only_allowed_files_staged) {
    violations.push(`허용 밖 파일이 stage됨 ${stagedOutOfScope.length}건: ${stagedOutOfScope.join(", ")}`);
  }

  // 6) 정리 안 된 새 파일(untracked) (baseline-relative)
  if (contract.git.require_no_staged_untracked && untracked.length) {
    violations.push(`정리 안 된 새 파일(untracked) ${untracked.length}건: ${untracked.join(", ")}`);
  }

  // 7) NUL(파일 깨짐) 검사
  const nulPaths = contract.required_checks?.nul?.paths ?? [];
  const nulBad: string[] = [];
  for (const p of nulPaths) {
    if (!existsSync(p)) continue;
    if (readFileSync(p).includes(0)) nulBad.push(p);
  }
  if (nulBad.length) {
    violations.push(`NUL 바이트(파일 깨짐) 발견: ${nulBad.join(", ")}`);
  }

  // 8) (v0.1) verify는 더 이상 필수 명령(commands)을 실행하지 않는다 — `guard check`가 담당.
  //     VerifyResult.commands 필드는 output.ts(printReport/toMarkdown) 하위호환을 위해
  //     형태만 유지하고 항상 빈 배열로 둔다. 실제 실행은 runCheck()를 보라.

  // 9) push 상태 (참고용)
  const aheadBehind = g.aheadBehind("origin/main");

  return {
    contractId: contract.id,
    title: contract.title,
    branch: { current, expected, ok: branchOk },
    touched,
    staged,
    untracked,
    outOfScope,
    deniedHits,
    stagedOutOfScope,
    nulPaths,
    nulBad,
    commands: [],
    headHash: g.headHash(),
    aheadBehind,
    violations,
    ok: violations.length === 0,
  };
}

// ── check 명령: 계약의 required_checks.commands 만 실행한다 ──
// verify(상태 검사)와 책임을 분리한 것. git 상태에 의존하지 않는다.
export type CheckResult = {
  contractId: string;
  title?: string;
  commands: CommandResult[];
  ok: boolean;
};

export function runCheck(contract: Contract): CheckResult {
  const commands: CommandResult[] = [];
  for (const c of contract.required_checks?.commands ?? []) {
    commands.push(runCommand(c.name, c.command, c.required_exit ?? 0));
  }
  // 명령이 하나도 없으면 ok=true(빈 배열 every) — vacuous PASS.
  // 사람용 출력(printCheckReport)에서 "검사할 명령 없음"을 명시한다.
  return {
    contractId: contract.id,
    title: contract.title,
    commands,
    ok: commands.every((c) => c.ok),
  };
}
