import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// baseline(.agent-guard/session.json)을 제거한다. git repo / contract 불필요. 항상 exit 0.
// contract.yaml / README.md 는 건드리지 않는다(session 만 제거).
// 비-exit core: session.json 제거 시도. close-recon 등 재사용. 출력/exit 없음.
export function resetCore(cwd: string = process.cwd()): { removed: boolean } {
  const p = join(cwd, ".agent-guard", "session.json");
  if (existsSync(p)) {
    rmSync(p);
    return { removed: true };
  }
  return { removed: false };
}

export function runReset(cwd: string = process.cwd()): never {
  if (resetCore(cwd).removed) {
    console.log("baseline 제거됨: .agent-guard/session.json (이제 verify 는 full-tree 로 검사)");
  } else {
    console.log("제거할 baseline 없음 (.agent-guard/session.json 이 없습니다)");
  }
  process.exit(0);
}
