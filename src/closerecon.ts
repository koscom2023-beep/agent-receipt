import type { Contract } from "./schema.js";
import { buildReceipt, writeReceiptFile } from "./receipt.js";
import { buildAuditPack } from "./auditpack.js";
import { resetCore } from "./reset.js";
import { resolveSession } from "./session.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

/**
 * `agent-receipt close-recon` — 읽기 전용 정찰 세션을 한 번에 닫는다(0.9).
 *  변경(touched/staged/untracked/denied/outOfScope)이 전부 0 일 때만:
 *    receipt 저장 → audit-pack 생성 → baseline reset.
 *  변경이 있으면(=구현 흔적) reset 하지 않고 중단(finish/prepare-commit 안내). exit 0/1.
 *  구현 세션(kind=implementation)은 자동 정리 거부 — 사람이 커밋하는 경로를 강제.
 */
export function runCloseRecon(contract: Contract, contractPath: string | undefined, cwd: string = process.cwd()): never {
  const r = buildReceipt(contract, contractPath);
  const sess = resolveSession(cwd);

  console.log("");
  console.log(line);
  console.log(`agent-receipt close-recon: ${r.contractId}`);
  console.log(line);

  // 0) implementation 세션 자동 정리 거부(구현은 finish/prepare-commit → 사람 커밋 경로).
  if (sess.session?.kind === "implementation") {
    console.log("거부: 이 세션은 kind=implementation 입니다.");
    console.log("  close-recon 은 읽기 전용 정찰 세션 전용입니다.");
    console.log("  구현이면:  agent-receipt finish  또는  agent-receipt prepare-commit  → 사람이 커밋 → reset");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(1);
  }

  // 1) clean-gate: 변경이 하나도 없어야 정찰로 인정(baseline-relative, tool 산출 제외는 buildReceipt 가 처리).
  const dirty: string[] = [];
  if (r.touched.length) dirty.push(`touched ${r.touched.length}`);
  if (r.staged.length) dirty.push(`staged ${r.staged.length}`);
  if (r.untracked.length) dirty.push(`untracked ${r.untracked.length}`);
  if (r.deniedHits.length) dirty.push(`denied ${r.deniedHits.length}`);
  if (r.outOfScope.length) dirty.push(`outOfScope ${r.outOfScope.length}`);

  if (dirty.length) {
    console.log(`변경 감지: ${dirty.join(", ")} — 정찰 세션이 아닙니다(코드 변경 있음).`);
    for (const f of r.touched) console.log(`   - ${f}`);
    console.log("");
    console.log("close-recon 은 변경 0 일 때만 자동 정리합니다 — baseline reset 안 함.");
    console.log("  구현이면:  agent-receipt finish  /  agent-receipt prepare-commit  → 사람이 커밋 → reset");
    console.log(line);
    console.log("  " + LIMIT_NOTE);
    console.log("");
    process.exit(1);
  }

  // 2) clean → receipt 저장 + audit-pack + baseline reset.
  const rec = writeReceiptFile(r, "json", undefined, false);
  const pack = buildAuditPack(contract, contractPath, undefined, undefined, false, false, cwd);
  const { removed } = resetCore(cwd);

  console.log("정찰 세션 종료 — 변경 파일 0, 커밋 불필요.");
  console.log(`  receipt 저장   : ${rec.rel}`);
  console.log(`  audit-pack 생성: ${pack.relDir}/ (${pack.fileCount} files)`);
  console.log(`  baseline reset : ${removed ? "완료 (.agent-guard/session.json 제거)" : "없음"}`);
  console.log("");
  console.log("다음 작업은 새 begin 으로 시작하세요(정찰↔구현 경계 분리).");
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(0);
}
