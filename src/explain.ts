import type { Contract } from "./schema.js";
import { runVerify } from "./checks.js";
import { recoveryHints } from "./output.js";
import { collectMagnitude, criticalPathHits, touchedFull } from "./evidence.js";

const line = "─".repeat(56);

/**
 * `agent-receipt explain` — 현재 계약 + git 상태 기준으로 왜 PASS/FAIL 인지 사람말로 설명한다.
 * exit code 는 verify 와 동일(PASS 0 / FAIL 1): 게이트에서 FAIL 을 0 으로 숨기지 않는 쪽이 더 안전하다.
 * runVerify 판정을 그대로 쓰고(재해석 없음), magnitude/critical 은 참고 증거로 덧붙인다.
 */
export function runExplain(contract: Contract): never {
  const r = runVerify(contract);
  const mag = collectMagnitude();
  const crit = criticalPathHits(touchedFull());

  console.log("");
  console.log(line);
  console.log(`agent-receipt explain: ${r.contractId}  — 왜 ${r.ok ? "PASS" : "FAIL"} 인가 (git 상태 기준)`);
  console.log(line);

  // 브랜치
  if (r.branch.expected) {
    console.log(
      `브랜치   : ${r.branch.current || "(없음)"} ${r.branch.ok ? "==" : "≠"} 기대 ${r.branch.expected} ${r.branch.ok ? "✓" : "✗ 위반"}`,
    );
  } else {
    console.log(`브랜치   : ${r.branch.current || "(없음)"} (기대 없음 → 검사 안 함)`);
  }

  // 범위(allowed)
  if (contract.scope.allowed_paths.length === 0) {
    console.log("범위     : allowed_paths 비어 있음 → 범위검사 꺼짐(denied + git 으로만 보호)");
  } else if (r.outOfScope.length) {
    console.log(`범위     : 변경 ${r.touched.length}건 중 범위 밖 ${r.outOfScope.length}건 ✗ — ${r.outOfScope.join(", ")}`);
  } else {
    console.log(`범위     : 변경 ${r.touched.length}건 모두 allowed_paths 안 ✓`);
  }

  // 금지(denied)
  if (r.deniedHits.length) {
    console.log(`금지     : denied 경로 ${r.deniedHits.length}건 닿음 ✗ — ${r.deniedHits.join(", ")}`);
  } else {
    console.log("금지     : denied 경로 변경 없음 ✓");
  }

  // 규모(숫자만)
  console.log(
    `규모     : 파일 ${mag.filesChanged} 변경, +${mag.added}/-${mag.deleted} 라인, 새 파일 ${mag.newFiles} (git numstat — 숫자만, 판단 아님)`,
  );

  // critical paths
  const hitCrit = crit.filter((c) => c.touched.length);
  if (hitCrit.length) {
    console.log(`critical : ⚠️ 고위험 경로 변경 — ${hitCrit.map((c) => `${c.glob}(${c.touched.join(",")})`).join("; ")}`);
  } else {
    console.log("critical : 고위험 경로(.env*/lockfile/migrations/workflows 등) 변경 없음 ✓");
  }

  console.log(line);
  if (r.ok) {
    console.log("결론: PASS ✅ — 위 검사를 모두 만족.");
  } else {
    console.log(`결론: FAIL ❌ — 위반 ${r.violations.length}건:`);
    for (const v of r.violations) console.log(`   ! ${v}`);
    const hints = recoveryHints(r, contract);
    if (hints.length) {
      console.log("다음 조치:");
      for (const x of hints) console.log(`   → ${x}`);
    }
  }
  console.log(line);
  console.log("");
  process.exit(r.ok ? 0 : 1);
}
