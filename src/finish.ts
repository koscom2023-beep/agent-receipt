import type { Contract } from "./schema.js";
import { buildReceipt, writeReceiptFile } from "./receipt.js";
import { evaluateCommitCheck, buildTrailer } from "./commitcheck.js";
import { buildAuditPack } from "./auditpack.js";
import { classifyTouched } from "./linked.js";
import { printCommitBlocks } from "./preparecommit.js";
import { loadPolicySafe, policyPath } from "./policy.js";
import { hashFileOrNull } from "./environment.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

/**
 * `agent-receipt finish [--message <m>] [--client]` (0.9)
 *   구현 작업 종료 1발: done(receipt) → commit-check → audit-pack → 커밋 블록.
 *   각 단계 PASS/FAIL 을 라벨로 출력해 실패지점을 명확히 한다. 자동 add/commit/reset/push 0.
 *   commit-check 차단 시 커밋 블록을 생략하고 "다음 한 명령"을 안내(exit 1).
 */
export function runFinish(
  contract: Contract,
  contractPath: string | undefined,
  message: string | undefined,
  client: boolean,
  cwd: string = process.cwd(),
): never {
  console.log("");
  console.log(line);
  console.log(`agent-receipt finish: ${contract.id}  (done+commit-check+audit-pack+커밋블록 — 자동 git 없음)`);
  console.log(line);

  // [1/4] done — receipt 저장.
  const r = buildReceipt(contract, contractPath);
  const rec = writeReceiptFile(r, "json", undefined, false);
  let clientLine = "";
  if (client) {
    const cm = writeReceiptFile(r, "client-md", undefined, false);
    clientLine = `, client ${cm.rel}`;
  }
  console.log(`  [1/4] done         : ${r.ok ? "PASS ✅" : "FAIL ❌"} — receipt ${rec.rel}${clientLine}`);

  // [2/4] commit-check — 게이트 평가(비-exit core 재사용).
  const cc = evaluateCommitCheck(contract, contractPath, cwd);
  if (cc.allOk) {
    console.log("  [2/4] commit-check : OK ✅");
  } else {
    console.log(`  [2/4] commit-check : 차단 ❌ (${cc.gates.filter((g) => !g.ok).length}건)`);
    for (const g of cc.gates.filter((g) => !g.ok)) console.log(`         ✗ ${g.label}: ${g.detail}`);
  }

  // [3/4] audit-pack — 증거는 PASS/FAIL 무관하게 남긴다.
  const pack = buildAuditPack(contract, contractPath, undefined, undefined, false, false, cwd);
  console.log(`  [3/4] audit-pack   : ${pack.relDir}/ (${pack.fileCount} files)`);

  console.log(line);

  // [4/4] 커밋 블록 또는 다음 명령.
  if (!cc.allOk) {
    console.log("  [4/4] 커밋 블록    : 생략 — commit-check 차단.");
    console.log("");
    console.log("다음 한 명령:  agent-receipt explain   (왜 차단인지) → 해결 후 다시 finish");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(1);
  }

  const cls = classifyTouched(r.touched, contract);
  const addFiles = cls.allowed;
  if (!addFiles.length) {
    console.log("  [4/4] 커밋 블록    : 변경 없음 — 커밋 불필요. (정찰이면 close-recon)");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(0);
  }

  console.log("  [4/4] 커밋 블록    : 아래 복붙 (자동 commit/add/push 안 함)");
  console.log("");
  const { policy } = loadPolicySafe(cwd);
  const polHash = policy ? hashFileOrNull(policyPath(cwd)) : null;
  const trailer = buildTrailer(r.contentHash, rec.rel, hashFileOrNull(contractPath), polHash);
  const msg = message ?? `chore(${r.contractId}): <요약 작성>`;
  printCommitBlocks(addFiles, msg, trailer);
  console.log("커밋 성공 후 reset 으로 세션을 닫으세요(위 reset 블록).");
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
