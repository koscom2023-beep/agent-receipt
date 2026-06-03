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

// git config 의 사용자(approve 등에서 approver 표기용). 없으면 빈 문자열.
export function gitUser(): { name: string; email: string } {
  let name = "";
  let email = "";
  try {
    name = git(["config", "user.name"]);
  } catch {
    /* 미설정 */
  }
  try {
    email = git(["config", "user.email"]);
  } catch {
    /* 미설정 */
  }
  return { name, email };
}

export function headHash(): string {
  try {
    return git(["rev-parse", "HEAD"]);
  } catch {
    return "(커밋 없음)";
  }
}

// 저장소 최상위 절대경로(환경/출처 캡처용). repo 밖/git 없으면 null.
export function repoRoot(): string | null {
  try {
    return git(["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

// 특정 커밋 해시가 현재 저장소에 존재하는지(replay 검증용). 빈/잘못된 입력은 false.
export function commitExists(hash: string): boolean {
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) return false;
  try {
    // ^{commit} 으로 실제 커밋 객체인지까지 확인(태그/트리 오인 방지)
    execFileSync("git", ["cat-file", "-e", `${hash}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
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

// 변경 규모(라인 수) — `git diff HEAD --numstat` 기반: 추적 파일의 추가/삭제 라인 + 변경 파일 수.
// 의미 판단/점수화 없음(숫자만). 경로 문자열은 쓰지 않으므로 비ASCII 경로의 C-quoting 과 무관하다.
// 바이너리 파일은 numstat 이 '-\t-' 로 표시 → 파일 수에는 세고 라인 수에는 0 으로 둔다.
export type LineStat = { filesChanged: number; added: number; deleted: number };
export function numstatVsHead(): LineStat {
  let filesChanged = 0;
  let added = 0;
  let deleted = 0;
  try {
    const out = git(["diff", "HEAD", "--numstat"]);
    for (const ln of out.split("\n")) {
      if (!ln) continue;
      filesChanged++;
      const [a, d] = ln.split("\t");
      if (a && a !== "-") added += Number(a) || 0;
      if (d && d !== "-") deleted += Number(d) || 0;
    }
  } catch {
    /* HEAD 없음(커밋 0개) 등 → 0 */
  }
  return { filesChanged, added, deleted };
}
