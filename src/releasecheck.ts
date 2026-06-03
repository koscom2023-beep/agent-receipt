import { existsSync, readFileSync } from "node:fs";
import * as g from "./git.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

// risk class 휴리스틱 — 커밋 제목 + 변경 파일 glob 기반 "추정"일 뿐(점수화 아님, 거짓확신 금지).
function riskFindings(subjects: string[], files: string[]): string[] {
  const out: string[] = [];
  const has = (re: RegExp): boolean => files.some((x) => re.test(x));
  const subj = subjects.join("\n").toLowerCase();
  if (has(/(^|\/)supabase\/migrations\/|(^|\/)package-lock\.json$|(^|\/)pnpm-lock\.yaml$|(^|\/)vercel\.json$|(^|\/)\.github\/workflows\//)) {
    out.push("infra: 마이그레이션/락파일/배포설정/CI 변경 — 롤백 영향 큼");
  }
  if (files.length && files.every((x) => /\.(md|mdx)$/.test(x) || x.startsWith("docs/"))) {
    out.push("docs: 문서만 변경(런타임 영향 낮음)");
  }
  if (has(/\.(test|spec)\.[tj]sx?$/) || has(/(^|\/)(tests?|__tests__)\//)) {
    out.push("test: 테스트 변경 포함");
  }
  if (/observe|관측|fire-and-forget|studiolog/.test(subj)) out.push("observe-only(추정): 커밋 제목에 관측 신호");
  if (/measure|측정/.test(subj)) out.push("measure-first(추정): 커밋 제목에 측정 신호");
  if (/refactor|리팩터|behavior.?frozen|동작.?보존/.test(subj)) out.push("behavior-frozen-refactor(추정): 동작 보존 신호");
  if (has(/\.(ts|tsx|js|jsx|py|go|rs|java|rb)$/)) out.push("behavior-change(추정): 코드 파일 변경 — 동작 영향 가능, 검토 필요");
  if (!out.length) out.push("unknown: 자동 분류 불가 — 사람이 직접 검토");
  return out;
}

/**
 * `agent-receipt release-check --base <ref> [--failed-tests <file>] [--observe <event>...]` (0.9)
 *   배포 전 read-only 분석: base/head, ahead/behind, rollbackBase, 변경 파일, 커밋, risk(휴리스틱),
 *   failed test ∩ changed(파일 줬을 때만), notVerified, postDeployObserve.
 *   ★ push/deploy/checkout/reset 절대 안 함 — 분석/표시만.
 */
export function runReleaseCheck(
  base: string | undefined,
  failedTestsFile: string | undefined,
  observeEvents: string[],
  cwd: string = process.cwd(),
): never {
  if (!base) {
    console.error("release-check: --base <ref> 가 필요합니다 (예: --base origin/main).");
    process.exit(2);
  }
  const baseHash = g.resolveRef(base);
  if (!baseHash) {
    console.error(`release-check: base ref 를 찾을 수 없음: ${base}`);
    process.exit(2);
  }

  const ab = g.aheadBehind(base);
  const commits = g.commitsBetween(base);
  const changed = g.changedFilesBetween(base);

  console.log("");
  console.log(line);
  console.log("agent-receipt release-check (배포 전 read-only 분석 — push/deploy 안 함)");
  console.log(line);
  console.log(`base           : ${base}  (${baseHash})`);
  console.log(`head           : ${g.headHash()}`);
  console.log(`ahead/behind   : +${ab ? ab.ahead : "?"} / -${ab ? ab.behind : "?"}`);
  console.log(`rollbackBase   : ${baseHash}  (배포 후 문제 시 이 커밋으로 되돌리기)`);

  console.log(`변경 파일      : ${changed.length}`);
  for (const f of changed) console.log(`   - ${f}`);
  console.log(`커밋           : ${commits.length}`);
  for (const c of commits) console.log(`   - ${c.hash.slice(0, 7)} ${c.subject}`);

  console.log("risk class (휴리스틱 — 커밋 제목/파일 기반 추정, 점수 아님):");
  for (const r of riskFindings(commits.map((c) => c.subject), changed)) console.log(`   - ${r}`);

  const notVerified: string[] = [];
  if (failedTestsFile) {
    if (existsSync(failedTestsFile)) {
      const failed = readFileSync(failedTestsFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
      const inter = failed.filter((f) => changed.includes(f));
      console.log(`실패 테스트 ∩ 변경: ${inter.length}건${inter.length ? " — " + inter.join(", ") : ""}`);
    } else {
      notVerified.push(`failed-tests 파일 없음: ${failedTestsFile}`);
    }
  } else {
    notVerified.push("failed test ∩ changed 미검사 (--failed-tests <file> 로 제공)");
  }

  if (observeEvents.length) {
    console.log("배포 후 관측(postDeployObserve):");
    for (const e of observeEvents) console.log(`   - ${e}`);
  }

  if (notVerified.length) {
    console.log("notVerified (이 도구가 확인 못 한 것):");
    for (const n of notVerified) console.log(`   - ${n}`);
  }

  console.log(line);
  console.log("  push/deploy/checkout/reset 는 하지 않습니다(read-only 분석).");
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
