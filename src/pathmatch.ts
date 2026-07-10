import { minimatch } from "minimatch";

// ── 경로 glob 매칭 SSOT ──
// v0.24 보안수정(리뷰 #5 High): deny/forbid/scope/critical glob 매칭은 파일시스템 대소문자 규칙을 따라야 한다.
// macOS·Windows 는 대소문자 무시 FS 라, nocase 없이 minimatch 하면 forbidAlways: ".env" 가
//   에이전트의 `.ENV`·`key.PEM`·`Secrets/prod.key` 쓰기를 못 막는다(minimatch(".ENV",".env")=false → 우회).
// Linux 등 대소문자 구분 FS 는 정확 매칭을 유지한다(nocase=false).
// 모든 경로 boundary(guard·policy·checks·evidence·linked·start)가 이 한 곳을 쓴다(일관 SSOT).
export const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export function matchGlob(file: string, glob: string): boolean {
  return minimatch(file, glob, { dot: true, nocase: CASE_INSENSITIVE_FS });
}
