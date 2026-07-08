import type { Contract } from "./schema.js";
import { loadContract } from "./schema.js";
import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { loadSession } from "./session.js";
import { runVerify } from "./checks.js";
import { printReport } from "./output.js";
import { t } from "./lang.js";

/**
 * 인자 없이 `agent-receipt` 만 실행했을 때의 단일명령 라우팅.
 * 현재 상태를 보고 "다음에 뭘 하면 되는지"로 안내하거나, 준비됐으면 verify 를 실행한다.
 * `help`/`--help` 동작과 충돌하지 않게 cli 에서 그쪽을 먼저 가로챈다.
 * 모든 경로에서 process.exit 로 끝난다.
 */
export function runDefault(): never {
  const cPath = discoverContract();

  // 1) 계약 없음 = 신규 사용자 → 딱딱한 "계약 없음" 대신 환영 + quickstart 우선(U1·U3).
  if (!cPath) {
    console.log("");
    console.log(t("welcome.hi"));
    console.log(`  ${t("model.oneline")}`);
    console.log("");
    console.log(t("welcome.start"));
    console.log(t("welcome.then"));
    console.log("");
    process.exit(0);
  }

  let contract: Contract;
  try {
    contract = loadContract(cPath);
  } catch (e: any) {
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }

  // 2) 계약은 있는데 git repo 아님 → 한 명령
  if (!g.isGitRepo()) {
    console.log(`\nagent-receipt — 계약 '${contract.id}' 발견. 여기는 git 저장소가 아닙니다.`);
    console.log("  다음: agent-receipt check\n");
    process.exit(0);
  }

  // 3) git repo + 계약, session 없음 → begin 안내(0.9 진입점)
  if (!loadSession()) {
    console.log(`\nagent-receipt — 계약 '${contract.id}' 발견, baseline 없음.`);
    console.log("  다음: agent-receipt begin --cursor [--kind recon|implementation|...]\n");
    process.exit(0);
  }

  // 4) session 있음 → verify(상세) 후 next 로 라우팅(한 명령). run=상세, next=한 명령.
  const r = runVerify(contract);
  printReport(r, contract);
  console.log(
    r.ok
      ? "다음: agent-receipt next   (지금 할 한 명령)\n"
      : "다음: agent-receipt explain   (왜 FAIL 인지 + 다음 조치)\n",
  );
  process.exit(r.ok ? 0 : 1);
}
