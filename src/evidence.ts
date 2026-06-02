import { minimatch } from "minimatch";
import * as g from "./git.js";
import { isToolOutput } from "./session.js";

// verify 와 동일하게 tool 산출물(session.json / receipts / keys / dashboard.html)은 증거 집계에서 제외한다.
const isToolFile = isToolOutput;

// ── 변경 규모(Change Magnitude) ──
// git 숫자만. 추적 파일 라인 수는 numstat(=HEAD 대비 working tree, staged+unstaged),
// 새 파일은 untracked 개수(tool 산출 제외). baseline-relative 가 아니라 full working tree 기준이다.
export interface Magnitude {
  filesChanged: number; // 추적 파일 중 HEAD 대비 내용 diff 가 있는 파일 수
  added: number; // numstat 추가 라인 합
  deleted: number; // numstat 삭제 라인 합
  newFiles: number; // untracked 신규 파일 수(tool 산출 제외)
}

export function collectMagnitude(): Magnitude {
  const ns = g.numstatVsHead();
  const newFiles = g.untrackedFiles().filter((f) => !isToolFile(f)).length;
  return { filesChanged: ns.filesChanged, added: ns.added, deleted: ns.deleted, newFiles };
}

// ── Critical Path Attestation ──
// 계약 스키마에 필드를 추가하지 않는다(고정 코드 상수). denied_paths 와 겹쳐도 무방하다.
// git 상태(full working tree)만 사용해 "고위험 경로가 닿았는지"를 표시만 한다(차단 아님).
export const DEFAULT_CRITICAL_PATHS = [
  ".env*",
  "package-lock.json",
  "pnpm-lock.yaml",
  "supabase/migrations/**",
  "vercel.json",
  ".github/workflows/**",
] as const;

export interface CriticalPath {
  glob: string;
  touched: string[]; // 이 glob 에 매칭된 (full-tree) 변경 파일들
}

// 전체 working tree 변경 집합(unstaged ∪ staged ∪ untracked, tool 산출 제외).
// denied 와 동일하게 baseline 으로 숨기지 않는 full-tree 기준이다.
export function touchedFull(): string[] {
  const all = [...g.unstagedFiles(), ...g.stagedFiles(), ...g.untrackedFiles()];
  return [...new Set(all)].filter((f) => !isToolFile(f));
}

export function criticalPathHits(files: string[]): CriticalPath[] {
  return DEFAULT_CRITICAL_PATHS.map((glob) => ({
    glob,
    touched: files.filter((f) => minimatch(f, glob, { dot: true })),
  }));
}
