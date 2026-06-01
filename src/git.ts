import { execFileSync } from "node:child_process";

function git(args: string[]): string {
  // stderr는 무시 — 실패는 호출부에서 try/catch로 직접 처리한다
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function toList(out: string): string[] {
  return out ? out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

export function isGitRepo(): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

export function currentBranch(): string {
  try {
    return git(["branch", "--show-current"]);
  } catch {
    return "";
  }
}

// 아직 stage 안 한 (tracked) 파일 변경
export function unstagedFiles(): string[] {
  return toList(git(["diff", "--name-only"]));
}

// stage된 파일 (새로 추가된 파일도 여기 포함됨)
export function stagedFiles(): string[] {
  return toList(git(["diff", "--cached", "--name-only"]));
}

// 추적 안 되는 새 파일 (.gitignore 된 건 제외)
export function untrackedFiles(): string[] {
  return toList(git(["ls-files", "--others", "--exclude-standard"]));
}

export function headHash(): string {
  try {
    return git(["rev-parse", "HEAD"]);
  } catch {
    return "(커밋 없음)";
  }
}

// origin/main 대비 로컬이 몇 커밋 앞/뒤인지 (push 여부 참고용 — 완벽하진 않음)
export function aheadBehind(upstream: string): { ahead: number; behind: number } | null {
  try {
    const out = git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    const [behind, ahead] = out.split(/\s+/).map((n) => Number(n));
    return { ahead, behind };
  } catch {
    return null;
  }
}
