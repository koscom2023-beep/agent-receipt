import type { Contract } from "./schema.js";
import * as g from "./git.js";
import { resolveSession, SESSION_REL_PATH } from "./session.js";

const line = "─".repeat(56);

// 현재 계약 / 세션(baseline) / git 상태를 사람이 보기 좋게 요약한다(read-only). 항상 exit 0.
export function runStatus(contract: Contract): never {
  const branch = g.currentBranch();
  const expected = contract.branch?.expected;
  const ex = (a: string[]): string[] => a.filter((f) => f !== SESSION_REL_PATH);
  const unstaged = ex(g.unstagedFiles());
  const staged = ex(g.stagedFiles());
  const untracked = ex(g.untrackedFiles());
  const touched = new Set([...unstaged, ...staged, ...untracked]).size;
  const sess = resolveSession();

  console.log("");
  console.log(line);
  console.log(`agent-receipt status: ${contract.id}`);
  console.log(line);
  console.log(
    `브랜치        : ${branch || "(없음)"}` +
      (expected ? ` (기대: ${expected}) ${expected === branch ? "OK" : "✗"}` : ""),
  );
  console.log(
    `계약 범위     : allowed ${contract.scope.allowed_paths.length}개 / denied ${contract.scope.denied_paths.length}개`,
  );
  if (sess.applied) {
    console.log(
      `baseline      : 활성 (head ${sess.session.baselineHead.slice(0, 7)}, branch ${sess.session.gitBranch})`,
    );
  } else if (sess.session) {
    console.log(
      `baseline      : ⚠️ 무효(${sess.reason}) → full-tree 로 검사함. 'agent-receipt reset' 후 'agent-receipt start' 권장`,
    );
  } else {
    console.log("baseline      : 없음 ('agent-receipt start' 로 기록)");
  }
  console.log(
    `변경(현재)    : ${touched}개 (unstaged ${unstaged.length}, staged ${staged.length}, untracked ${untracked.length})`,
  );
  console.log(line);
  console.log("");
  process.exit(0);
}
