import { execFileSync } from "node:child_process";

function git(args: string[]): string {
  // stderr는 무시 — 실패는 호출부에서 try/catch로 직접 처리한다
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// 파일 경로 목록 전용 수집기. -z(NUL 종단)로 받아 git 의 C-style quoting/octal escape 를 피하고
// 한글·공백·특수문자 경로를 raw UTF-8 그대로 얻는다. 경로 양끝 공백이 실제 파일명일 수 있어 trim 하지 않는다.
function gitPaths(args: string[]): string[] {
  const out = execFileSync("git", [...args, "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.split("\0").filter((s) => s.length > 0);
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
  return gitPaths(["diff", "--name-only"]);
}

// stage된 파일 (새로 추가된 파일도 여기 포함됨)
export function stagedFiles(): string[] {
  return gitPaths(["diff", "--cached", "--name-only"]);
}

// 추적 안 되는 새 파일 (.gitignore 된 건 제외)
export function untrackedFiles(): string[] {
  return gitPaths(["ls-files", "--others", "--exclude-standard"]);
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

// ancestor 가 descendant 의 조상인지 (merge-base --is-ancestor: exit 0 = 조상). baseline 유효성 검사용.
export function isAncestor(ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// baseline..HEAD 사이에 커밋된 변경 파일 (patch_only 면 보통 빈 배열). -z/NUL 파싱.
export function committedSince(baseline: string): string[] {
  try {
    return gitPaths(["diff", "--name-only", `${baseline}..HEAD`]);
  } catch {
    return [];
  }
}
