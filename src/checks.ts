import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { minimatch } from "minimatch";
import type { Contract } from "./schema.js";
import * as g from "./git.js";

export type CommandResult = {
  name: string;
  command: string;
  exitCode: number;
  requiredExit: number;
  ok: boolean;
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
  return patterns.some((p) => minimatch(file, p, { dot: true }));
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
  return { name, command, exitCode, requiredExit, ok: exitCode === requiredExit };
}

export function runVerify(contract: Contract): VerifyResult {
  const violations: string[] = [];

  // 1) 브랜치 확인
  const current = g.currentBranch();
  const expected = contract.branch?.expected;
  const branchOk = !expected || expected === current;
  if (!branchOk) {
    violations.push(`브랜치 불일치: 현재 '${current}', 계약은 '${expected}'`);
  }

  // 2) AI가 건드린 파일 전부 모으기 (unstaged + staged + 새 파일)
  const unstaged = g.unstagedFiles();
  const staged = g.stagedFiles();
  const untracked = g.untrackedFiles();
  const touched = unique([...unstaged, ...staged, ...untracked]);

  const allowed = contract.scope.allowed_paths;
  const denied = contract.scope.denied_paths;

  // 3) 허용 목록 밖 변경
  const outOfScope = allowed.length ? touched.filter((f) => !matchesAny(f, allowed)) : [];
  if (outOfScope.length) {
    violations.push(`허용 범위 밖 변경 ${outOfScope.length}건: ${outOfScope.join(", ")}`);
  }

  // 4) 금지 목록에 닿은 변경
  const deniedHits = touched.filter((f) => matchesAny(f, denied));
  if (deniedHits.length && contract.git.require_no_denied_path_diff) {
    violations.push(`금지 파일 변경 ${deniedHits.length}건: ${deniedHits.join(", ")}`);
  }

  // 5) 허용 밖 파일이 stage됨
  const stagedOutOfScope = allowed.length ? staged.filter((f) => !matchesAny(f, allowed)) : [];
  if (stagedOutOfScope.length && contract.git.require_only_allowed_files_staged) {
    violations.push(`허용 밖 파일이 stage됨 ${stagedOutOfScope.length}건: ${stagedOutOfScope.join(", ")}`);
  }

  // 6) 정리 안 된 새 파일(untracked)
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

  // 8) 필수 명령 실행 (tsc, test 등)
  const commands: CommandResult[] = [];
  for (const c of contract.required_checks?.commands ?? []) {
    const res = runCommand(c.name, c.command, c.required_exit ?? 0);
    commands.push(res);
    if (!res.ok) {
      violations.push(`체크 실패 '${c.name}': exit ${res.exitCode} (기대 ${res.requiredExit})`);
    }
  }

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
    commands,
    headHash: g.headHash(),
    aheadBehind,
    violations,
    ok: violations.length === 0,
  };
}
