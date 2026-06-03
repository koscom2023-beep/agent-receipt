import type { Contract } from "./schema.js";
import { runVerify } from "./checks.js";
import { buildReceipt } from "./receipt.js";
import { buildTrailer } from "./commitcheck.js";
import { listReceipts } from "./receiptStore.js";
import { loadPolicySafe, policyPath } from "./policy.js";
import { hashFileOrNull } from "./environment.js";
import { classifyTouched } from "./linked.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

/**
 * 커밋 블록(heredoc)과 reset 블록을 물리적으로 분리 출력한다(0.9).
 *   heredoc EOF 와 `agent-receipt reset` 이 한 줄에 붙는 복붙 사고를 구조적으로 막는다.
 *   자동 git 실행 없음 — 사람이 복사해 실행한다. finish 가 공용으로 쓴다.
 */
export function printCommitBlocks(addFiles: string[], message: string, trailer: string[]): void {
  console.log("── 커밋 블록 (복사해서 실행) ──");
  console.log("");
  if (addFiles.length === 1) {
    console.log(`git add ${addFiles[0]}`);
  } else {
    console.log(addFiles.map((f, i) => (i === 0 ? `git add ${f}` : `        ${f}`)).join(" \\\n"));
  }
  console.log("");
  console.log("git commit -F - <<'EOF'");
  console.log(message);
  console.log("");
  for (const ln of trailer) console.log(ln);
  console.log("EOF");
  console.log("");
  console.log("── reset 블록 (커밋 성공 후에만 — 위 블록과 별도로 실행) ──");
  console.log("");
  console.log("agent-receipt reset");
  console.log("");
}

/**
 * `agent-receipt prepare-commit [--message <m>] [--include-linked-tests]` (0.9)
 *   verify + receipt 메타 기반으로 안전한 복붙 커밋 블록을 생성한다. 자동 commit/add 안 함.
 *   금지경로/진짜 범위 밖/브랜치 불일치/NUL 이 있으면 커밋 블록을 출력하지 않는다(exit 1).
 *   linked 가드 테스트는 verify 가 여전히 outOfScope 로 보지만, 사람 확인용으로 분리 표시한다.
 */
export function runPrepareCommit(
  contract: Contract,
  contractPath: string | undefined,
  message: string | undefined,
  includeLinkedTests: boolean,
  cwd: string = process.cwd(),
): never {
  const r = buildReceipt(contract, contractPath);
  const v = runVerify(contract); // NUL 검사(nulBad)는 VerifyResult 에만 있음 — Receipt 엔 없음.
  const cls = classifyTouched(r.touched, contract);

  console.log("");
  console.log(line);
  console.log(`agent-receipt prepare-commit: ${r.contractId}  (자동 commit/add 안 함 — 복붙 블록만)`);
  console.log(line);

  console.log(`허용 변경         : ${cls.allowed.length}`);
  for (const f of cls.allowed) console.log(`   - ${f}`);
  if (cls.linkedTests.length) {
    console.log(`linked 가드 테스트 : ${cls.linkedTests.length}  ⚠️ 허용 밖이지만 직접 가드 테스트로 보임 — 사람 확인 필요`);
    for (const f of cls.linkedTests) console.log(`   - ${f}`);
  }
  console.log(`진짜 범위 밖      : ${cls.trueOutOfScope.length}`);
  for (const f of cls.trueOutOfScope) console.log(`   - ${f}`);

  // 게이트: 금지/진짜 범위 밖/브랜치 불일치/NUL 이 있으면 커밋 블록 출력 금지.
  //   (linked 테스트만으로는 막지 않는다 — 사람 확인하에 포함 가능.)
  const blockReasons: string[] = [];
  if (r.deniedHits.length) blockReasons.push(`금지 경로(denied) ${r.deniedHits.length}건: ${r.deniedHits.join(", ")}`);
  if (cls.trueOutOfScope.length) blockReasons.push(`진짜 범위 밖 ${cls.trueOutOfScope.length}건: ${cls.trueOutOfScope.join(", ")}`);
  if (!r.branch.ok) blockReasons.push(`브랜치 불일치: 현재 ${r.branch.current || "(없음)"}, 기대 ${r.branch.expected}`);
  if (v.nulBad.length) blockReasons.push(`NUL(파일 깨짐): ${v.nulBad.join(", ")}`);

  if (blockReasons.length) {
    console.log(line);
    console.log("커밋 블록 생략 ❌ — 먼저 해결하세요(자동 revert 안 함):");
    for (const b of blockReasons) console.log(`   ! ${b}`);
    console.log("  확인: agent-receipt explain / commit-check");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(1);
  }

  const addFiles = [...cls.allowed];
  if (includeLinkedTests) addFiles.push(...cls.linkedTests);

  if (!addFiles.length) {
    console.log(line);
    console.log("커밋할 변경 없음 — add 후보 0. (정찰이면 close-recon)");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(0);
  }

  if (cls.linkedTests.length) {
    console.log("");
    console.log(`⚠️ linked 가드 테스트 ${cls.linkedTests.length}건은 계약 allowed_paths 밖입니다(verify 는 여전히 outOfScope 표시).`);
    console.log(
      includeLinkedTests
        ? "   --include-linked-tests 로 add 후보에 포함했습니다 — 사람이 확인 후 커밋하세요."
        : "   add 후보에서 제외했습니다 — 포함하려면 --include-linked-tests.",
    );
  }

  const { policy } = loadPolicySafe(cwd);
  const polHash = policy ? hashFileOrNull(policyPath(cwd)) : null;
  const latestRel = listReceipts(cwd).filter((x) => x.name.endsWith(".json"))[0]?.rel ?? null;
  const trailer = buildTrailer(r.contentHash, latestRel, hashFileOrNull(contractPath), polHash);
  const msg = message ?? `chore(${r.contractId}): <요약 작성>`;

  console.log(line);
  printCommitBlocks(addFiles, msg, trailer);
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
