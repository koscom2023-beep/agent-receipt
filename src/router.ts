import type { Contract } from "./schema.js";
import { loadContract } from "./schema.js";
import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { loadSession } from "./session.js";
import { runVerify } from "./checks.js";
import { printReport } from "./output.js";

/**
 * 인자 없이 `agent-receipt` 만 실행했을 때의 단일명령 라우팅.
 * 현재 상태를 보고 "다음에 뭘 하면 되는지"로 안내하거나, 준비됐으면 verify 를 실행한다.
 * `help`/`--help` 동작과 충돌하지 않게 cli 에서 그쪽을 먼저 가로챈다.
 * 모든 경로에서 process.exit 로 끝난다.
 */
export function runDefault(): never {
  const cPath = discoverContract();

  // 1) 계약 없음 → init 안내
  if (!cPath) {
    console.log("\nagent-receipt — 시작하려면 계약이 필요합니다.");
    console.log("  → agent-receipt init --preset generic    (.agent-guard/contract.yaml 생성)");
    console.log("  자세히: agent-receipt help\n");
    process.exit(0);
  }

  let contract: Contract;
  try {
    contract = loadContract(cPath);
  } catch (e: any) {
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }

  // 2) 계약은 있는데 git repo 아님 → git 무관 명령 안내
  if (!g.isGitRepo()) {
    console.log(`\nagent-receipt — 계약 '${contract.id}' 발견. 여기는 git 저장소가 아닙니다.`);
    console.log("  → agent-receipt check    (required_checks.commands 실행)");
    console.log("  → agent-receipt lint     (계약 품질 점검)\n");
    process.exit(0);
  }

  // 3) git repo + 계약, session 없음 → start 안내
  if (!loadSession()) {
    console.log(`\nagent-receipt — 계약 '${contract.id}' 발견, baseline(session) 없음.`);
    console.log("  → agent-receipt start    (작업 시작 baseline 기록 — ambient 노이즈 제거)");
    console.log("  또는 바로:  agent-receipt verify   (full-tree 검사)\n");
    process.exit(0);
  }

  // 4) session 있음 → verify 실행 후 결과별 다음 명령 안내
  const r = runVerify(contract);
  printReport(r, contract);
  if (r.ok) {
    console.log("다음: `agent-receipt check` (테스트/빌드) → 통과하면 직접 stage/commit. 증빙은 `agent-receipt receipt`.\n");
  } else {
    console.log("원인 설명: `agent-receipt explain`.  (자동 수정은 하지 않습니다 — 위 '다음 조치' 참고.)\n");
  }
  process.exit(r.ok ? 0 : 1);
}
