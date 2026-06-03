import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { loadContract } from "./schema.js";
import { resolveSession } from "./session.js";

const line = "─".repeat(56);

/**
 * `agent-receipt mode` — 지금 이 작업 흐름이 task mode 인지 daily mode 인지 사람이 이해하게 하는
 * read-only 설명/안내 명령(저장 파일 없음). git repo 가 아니어도 가능한 범위에서 안내한다. 항상 exit 0.
 *
 *  - task mode : 1개 작업 단위. start → 작업 → verify/check/claims/receipt → reset/commit. receipt 1개.
 *  - daily mode: 하루/브랜치에서 여러 작업 연속. 작업마다 reset→start 로 baseline 을 새로 찍고,
 *                누적 추적은 `agent-receipt receipts` 목록으로(별도 daily 스키마 없음).
 */
export function runMode(cwd: string = process.cwd()): never {
  const cPath = discoverContract(cwd);
  let contractId: string | null = null;
  let contractBad = false;
  if (cPath) {
    try {
      contractId = loadContract(cPath).id;
    } catch {
      contractBad = true;
    }
  }
  const isRepo = g.isGitRepo();
  const sess = isRepo ? resolveSession(cwd) : ({ applied: false, session: null, reason: null } as const);
  const hasSession = !!sess.session;
  const active = sess.applied;
  const stale = hasSession && !active;

  console.log("");
  console.log(line);
  console.log("agent-receipt mode — 지금 이 작업 흐름은?");
  console.log(line);
  console.log(`  계약       : ${cPath ? (contractBad ? "발견(형식오류)" : `발견 (${contractId})`) : "없음"}`);
  console.log(`  git 저장소 : ${isRepo ? "예" : "아니오"}`);
  console.log(`  baseline   : ${!hasSession ? "없음" : active ? "활성" : `무효(${sess.reason})`}${sess.session?.kind ? ` · kind=${sess.session.kind}` : ""}`);
  console.log(line);
  console.log("  ▸ task mode  — 1개 작업 단위");
  console.log("      start → (agent 작업) → verify → check → claims → receipt → reset/commit");
  console.log("      작업마다 receipt 1개. 끝나면 reset 후 다음 작업.");
  console.log("  ▸ daily mode — 하루/브랜치에서 여러 작업 연속");
  console.log("      작업마다 reset → start 로 baseline 을 새로 찍는다(권장).");
  console.log("      누적 추적은 `agent-receipt receipts` 목록으로 (별도 daily 스키마 없음).");
  console.log(line);

  let recommend: string;
  let next: string;
  if (!cPath) {
    recommend = "아직 모드 이전 — 계약부터.";
    next = "agent-receipt init --preset promptia   (또는 generic)";
  } else if (contractBad) {
    recommend = "계약 형식 오류 — 먼저 고치세요.";
    next = "agent-receipt doctor   (어디가 깨졌는지 확인)";
  } else if (!isRepo) {
    recommend = "git 저장소가 아님 — 상태검사는 불가.";
    next = "agent-receipt check / lint   (git 없이 가능한 점검)";
  } else if (!hasSession) {
    recommend = "task mode 시작 전 — baseline 미기록.";
    next = "agent-receipt start   (작업 baseline 기록)";
  } else if (stale) {
    recommend = "baseline 무효(브랜치/HEAD 변경) — 재시작 권장.";
    next = "agent-receipt reset → agent-receipt start";
  } else {
    recommend = "task mode 진행 중 (baseline 활성).";
    next = "agent-receipt run   (현재 상태 검사 + 다음 명령 안내)";
  }
  console.log(`  현재       : ${recommend}`);
  console.log(`  다음       : ${next}`);
  console.log(line);
  console.log("");
  process.exit(0);
}
