import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";

const line = "─".repeat(56);

// AI 완료보고(claim) — 모든 필드 optional. 제공된 필드만 git 실측과 대조한다.
// AI claim 은 절대 진실로 간주하지 않는다. 판정은 runVerify/runCheck 실측만 사용.
interface Claim {
  changedFiles?: unknown;
  newFiles?: unknown;
  deniedHits?: unknown;
  tests?: unknown;
  summary?: unknown;
  modeClaims?: unknown; // 0.9: 작업 모드 self-report(AI호출/DB write/관측 등) — git 으로 검증 불가
  externalActions?: unknown; // 0.9: git 밖 행동 self-report(memoryWrite/npmPublish/push/deploy 등)
}

// 0.9: self-report 블록(git 으로 검증 불가 — '주장'으로만 표시, mismatch 집계 안 함).
function printSelfReportBlock(label: string, obj: unknown): void {
  console.log(`${label} (self-report — git 작업트리 밖, 검증 불가):`);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, val] of Object.entries(obj as Record<string, unknown>)) {
      console.log(`  · ${k}: ${String(val)}`);
    }
  } else {
    console.log(`  · ${String(obj)}`);
  }
}

const cleanPath = (p: string): string => p.replace(/^\.\//, "");
function asSet(arr: unknown): Set<string> {
  return new Set(
    Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").map(cleanPath) : [],
  );
}
function only(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}
function fmt(s: Set<string>): string {
  return s.size ? [...s].sort().join(", ") : "(none)";
}

/**
 * `agent-receipt claims --file <path>` — AI 완료보고 JSON 을 git 실측과 대조한다.
 *  - 파일 없음/파싱 실패 → exit 2
 *  - mismatch 있음        → exit 1
 *  - 일치(또는 대조할 필드 없음) → exit 0
 * "AI said / Git says" 로 차이를 드러낸다(특히 AI 가 주장 안 한 변경 = 숨긴 변경).
 */
export function runClaims(contract: Contract, fileArg: string | undefined): never {
  if (!fileArg) {
    console.error("claims: --file <path> 가 필요합니다 (AI 완료보고 JSON).");
    process.exit(2);
  }
  const p = isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    console.error(`claims: 파일을 못 읽음: ${fileArg}`);
    process.exit(2);
  }
  let claim: Claim;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    claim = parsed as Claim;
  } catch {
    console.error(`claims: JSON 파싱 실패: ${fileArg}`);
    process.exit(2);
  }

  const v = runVerify(contract);

  console.log("");
  console.log(line);
  console.log(`claims 대조: ${contract.id}  (AI 주장 vs git 실측)`);
  console.log(line);

  let mismatches = 0;

  // 집합 대조 공통 출력(AI said / Git says + 차이).
  const compareSet = (
    label: string,
    aiRaw: unknown,
    gitArr: string[],
    hiddenMsg: string,
    extraMsg: string,
  ): void => {
    const ai = asSet(aiRaw);
    const git = asSet(gitArr);
    const hidden = only(git, ai); // git 에 있는데 AI 가 주장 안 함
    const extra = only(ai, git); // AI 주장했는데 git 에 없음
    const ok = hidden.length === 0 && extra.length === 0;
    if (!ok) mismatches++;
    console.log(`${label}:`);
    console.log(`  AI said : ${fmt(ai)}`);
    console.log(`  Git says: ${fmt(git)}`);
    if (ok) console.log("  ✓ 일치");
    else {
      if (hidden.length) console.log(`  ✗ ${hiddenMsg}: ${hidden.join(", ")}`);
      if (extra.length) console.log(`  ✗ ${extraMsg}: ${extra.join(", ")}`);
    }
  };

  if (claim.changedFiles !== undefined) {
    compareSet("changedFiles", claim.changedFiles, v.touched, "AI 가 주장하지 않은 변경(git 에 존재)", "git 에 없는 변경 주장");
  }
  if (claim.newFiles !== undefined) {
    compareSet("newFiles", claim.newFiles, v.untracked, "AI 가 주장하지 않은 새 파일", "git 에 없는 새 파일 주장");
  }
  if (claim.deniedHits !== undefined) {
    compareSet("deniedHits", claim.deniedHits, v.deniedHits, "AI 가 숨긴 금지경로 변경", "git 에 없는 금지경로 주장");
  }
  if (claim.tests !== undefined) {
    const chk = runCheck(contract);
    const aiPass = claim.tests === true;
    const ok = aiPass === chk.ok;
    if (!ok) mismatches++;
    console.log("tests:");
    console.log(`  AI said : ${aiPass ? "pass" : "not-pass"}`);
    console.log(`  Git says: ${chk.ok ? "pass" : `FAIL (${chk.commands.filter((c) => !c.ok).length}건 실패)`}`);
    console.log(ok ? "  ✓ 일치" : "  ✗ mismatch — AI 주장과 check 결과가 다름");
  }
  if (claim.summary !== undefined) {
    console.log(`summary  : ${String(claim.summary)}  (참고용 — 검증 안 함)`);
  }
  if (claim.modeClaims !== undefined) printSelfReportBlock("modeClaims", claim.modeClaims);
  if (claim.externalActions !== undefined) printSelfReportBlock("externalActions", claim.externalActions);

  console.log(line);
  console.log(
    mismatches
      ? `결과: mismatch ${mismatches}건 ❌  (AI 보고 ≠ git 실측 — git 을 믿으세요)`
      : "결과: 일치 ✅  (AI 보고 = git 실측)",
  );
  console.log(line);
  console.log("");
  process.exit(mismatches ? 1 : 0);
}
