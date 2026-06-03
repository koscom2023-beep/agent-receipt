import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { loadContract } from "./schema.js";
import { resolveSession } from "./session.js";
import { runVerify } from "./checks.js";
import { buildReceipt } from "./receipt.js";
import { listReceipts, parseReceiptJson } from "./receiptStore.js";

// 0.9 통합: next 는 "전체 흐름의 중심 라우터" — 지금 할 **한 명령**만 강하게 출력한다.
//   설명은 짧게, 추천은 하나, 자동 실행 없음. 상세 상태는 status, 한 명령은 next.
function say(cmd: string, reason: string, code = 0): never {
  console.log(`다음: ${cmd}`);
  console.log(`  (${reason})`);
  process.exit(code);
}

function hasAuditPack(cwd: string): boolean {
  const d = join(cwd, ".agent-guard", "audit-packs");
  try {
    return existsSync(d) && readdirSync(d).length > 0;
  } catch {
    return false;
  }
}

export function runNext(cwd: string = process.cwd()): never {
  const cPath = discoverContract(cwd);
  if (!cPath) say("agent-receipt init --preset <name>", "계약 없음 — 먼저 생성");
  try {
    loadContract(cPath as string);
  } catch {
    say("agent-receipt doctor", "계약 형식 오류 — 어디가 깨졌는지 확인");
  }
  const contract = loadContract(cPath as string);

  if (!g.isGitRepo()) say("agent-receipt check", "git 저장소 아님 — 명령 점검만 가능");

  const sess = resolveSession(cwd);
  if (!sess.session) say("agent-receipt begin --cursor --kind <recon|implementation|...>", "baseline 없음 — 작업 시작");
  if (!sess.applied) say("agent-receipt reset → agent-receipt begin", `baseline 무효(${sess.reason}) — 재시작`);

  const v = runVerify(contract);
  if (!v.ok) {
    // 원인 요약(짧게) — 무엇이 FAIL 인지 한눈에. verify --json 구조는 불변(여기서 새로 출력만).
    console.log("verify FAIL 요약:");
    console.log(`  touched         : ${v.touched.length}`);
    console.log(`  denied          : ${v.deniedHits.length}`);
    console.log(`  outOfScope      : ${v.outOfScope.length}`);
    console.log(`  stagedOutOfScope: ${v.stagedOutOfScope.length}`);
    console.log(`  untracked       : ${v.untracked.length}`);
    const rep = [...v.deniedHits, ...v.stagedOutOfScope, ...v.outOfScope, ...v.touched]
      .filter((x, i, a) => a.indexOf(x) === i)
      .slice(0, 3);
    if (rep.length) console.log(`  대표 파일       : ${rep.join(", ")}`);
    console.log("");
    say("agent-receipt explain", "원인 자세히 — 무엇이/왜 FAIL 인지(자동 수정/커밋 안 함)", 1);
  }

  const kind = sess.session?.kind;
  if (v.touched.length === 0) {
    if (kind === "implementation") say("agent-receipt reset", "변경 0 — 커밋할 것 없음(구현 세션)");
    say("agent-receipt close-recon", "변경 0 — 정찰 세션 종료(receipt+audit-pack+reset)");
  }

  // 변경 있음 → done → audit-pack → prepare-commit 순서로 라우팅.
  const fresh = buildReceipt(contract, cPath);
  const latest = listReceipts(cwd).filter((e) => e.name.endsWith(".json"))[0] ?? null;
  const latestJson = latest ? parseReceiptJson(latest.abs) : null;
  const receiptMatches = !!latestJson && latestJson.contentHash === fresh.contentHash;

  if (!receiptMatches) say("agent-receipt done", "변경 있음 — 현재 변경과 일치하는 receipt 없음");
  if (!hasAuditPack(cwd)) say("agent-receipt audit-pack", "receipt 있음 — 증거 묶음 없음");
  say("agent-receipt prepare-commit", "audit-pack 있음 — 커밋 블록 생성(자동 커밋 안 함)");
}
