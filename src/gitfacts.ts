import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ── git/의존성 사실 조회 surface (Phase4) ──
// 커널(evidencekernel.ts)은 이 모듈을 모른다(core ↛ surface 불변식 유지) — 여기서 IO(git 프로세스 실행·
//   파일 읽기)를 하고, 계산된 사실(불리언/텍스트/맵)만 research.ts·council.ts 가 커널에 넘긴다.
// execFileSync(배열 인자) 사용 — 셸 문자열 조합 없음(커밋해시/경로에 셸 메타문자 있어도 인젝션 불가).
// 전부 조회 실패 → null(no-basis 로 이어짐. "커밋 없음"과 "조회 불가"를 섞지 않는다 — 거짓 판정 금지).

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// 커밋 실재 여부. true=존재·false=레포는 맞는데 그 커밋 없음(진짜 mismatch)·null=레포 자체가 아님/조회 불가.
export function resolveCommitExists(commit: string, repoDir: string): boolean | null {
  if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) return null; // 커밋해시 형식 자체가 아님 → 조회 안 함(no-basis)
  if (!isGitRepo(repoDir)) return null;
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoDir, stdio: "ignore" });
    return true;
  } catch {
    return false; // 레포는 맞는데 그 커밋이 없음 — 확실한 mismatch
  }
}

// 그 커밋이 변경한 파일 목록(줄바꿈 구분). null=조회 불가(레포 아님·커밋 없음 등).
export function resolveChangedFiles(commit: string, repoDir: string): string | null {
  if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) return null;
  // --root: 부모 없는(최초) 커밋도 빈 트리 대비 diff 로 취급 — 없으면 root 커밋은 항상 빈 결과(거짓 no-basis).
  return runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit], repoDir);
}

// 그 커밋의 특정 경로 diff 텍스트. null=조회 불가.
export function resolveDiffText(commit: string, path: string, repoDir: string): string | null {
  if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) return null;
  return runGit(["show", commit, "--", path], repoDir);
}

// package.json(류)을 읽어 dependencies+devDependencies+peer+optional 을 이름→버전 맵으로 병합.
// null=파일 없음/파싱 실패.
export function resolveDependencyMap(pkgFile: string): Record<string, string> | null {
  let raw: string;
  try {
    raw = readFileSync(pkgFile, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const merged: Record<string, string> = {};
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const d = p[field];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) if (typeof v === "string") merged[k] = v;
    }
  }
  return merged;
}
