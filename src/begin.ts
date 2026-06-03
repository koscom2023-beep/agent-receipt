import type { Contract } from "./schema.js";
import { startCore } from "./start.js";
import { buildPrompt, type PromptVariant } from "./output.js";
import { evalTripwire, tripwireLines } from "./tripwire.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

/**
 * `agent-receipt begin [--cursor|--claude|--generic]` — 작업 시작을 한 명령으로.
 *   policy 확인(있으면) → start(baseline) → prompt 출력 → 다음 명령 안내.
 * start 가 이미 있으면(재시작) baseline 은 건너뛰고 prompt 만 다시 보여준다(편의). exit 0/1.
 */
export function runBegin(contract: Contract, variant: PromptVariant, cwd: string = process.cwd()): never {
  console.log("");
  console.log(line);
  console.log(`agent-receipt begin: ${contract.id}`);
  console.log(line);

  // 1) policy 상시규칙(있으면) — 시작 시점 관찰(advisory).
  const tw = tripwireLines(evalTripwire(cwd));
  if (tw.length) {
    console.log("상시 규칙(policy):");
    for (const x of tw) console.log(`  ${x}`);
    console.log("");
  }

  // 2) baseline 기록.
  const res = startCore(contract, cwd);
  if (!res.ok && res.reason === "denied-dirty") {
    console.error(res.message);
    process.exit(1);
  }
  if (!res.ok && res.reason === "exists") {
    console.log("baseline: 이미 있음 — 그대로 사용(재시작하려면 `reset` 후 `begin`).");
  } else if (res.ok) {
    console.log(res.message);
  }
  console.log("");

  // 3) 에이전트 지시문.
  console.log("── 아래 지시문을 AI 에이전트에 붙여 작업을 시작하세요 ──");
  console.log("");
  console.log(buildPrompt(contract, variant));
  console.log("");
  console.log(line);
  console.log("작업이 끝나면:  agent-receipt done [--claim <claim.json>] [--client]");
  console.log("  " + LIMIT_NOTE);
  console.log(line);
  console.log("");
  process.exit(0);
}
