import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as g from "./git.js";

// install-hooks 가 .git/hooks 로 쓰는 스크립트(동봉 상수). agent-receipt commit-check 게이트를 호출한다.
// 차단은 항상 --no-verify 로 우회 가능. 아래 MARKER 주석으로 "우리가 만든 hook"을 식별(멱등/안전 제거).
const MARKER = "agent-receipt install-hooks 가 생성";

const PRE_COMMIT = `#!/usr/bin/env bash
# ${MARKER} — pre-commit gate. 커밋 직전 verify/denied 게이트. 우회: git commit --no-verify
set -uo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" 2>/dev/null || exit 0
[ -f .agent-guard/contract.yaml ] || exit 0
command -v agent-receipt >/dev/null 2>&1 || exit 0
if ! agent-receipt commit-check; then
  echo "" >&2
  echo "✗ agent-receipt pre-commit 차단 — denied/out-of-scope/verify 해결 후 다시. 우회: git commit --no-verify" >&2
  exit 1
fi
exit 0
`;

const PRE_PUSH = `#!/usr/bin/env bash
# ${MARKER} — pre-push gate(얇은 안전망). 강한 게이트는 pre-commit. 우회: git push --no-verify
set -uo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" 2>/dev/null || exit 0
[ -f .agent-guard/contract.yaml ] || exit 0
command -v agent-receipt >/dev/null 2>&1 || exit 0
if ! agent-receipt commit-check; then
  echo "" >&2
  echo "✗ agent-receipt pre-push 차단 — 미해결 게이트. 우회: git push --no-verify" >&2
  exit 1
fi
exit 0
`;

// post-commit — 증거(영수증) 훅. 게이트(pre-commit)와 분리된 자리.
// 핵심: git 의 post-commit 은 --no-verify 로 우회되지 않는다 → 게이트를 --no-verify 로 넘겨도
// 이 훅은 실행돼 "방금 만든 커밋(parent..HEAD)"의 영수증을 남긴다(receipt --committed). 비차단(항상 exit 0).
const POST_COMMIT = `#!/usr/bin/env bash
# ${MARKER} — post-commit evidence(증거). --no-verify 로도 안 건너뜀 → 게이트 우회에도 영수증 생존.
# 방금 만든 커밋을 측정(receipt --committed). 증거지 게이트 아님 — 항상 통과(exit 0).
set -uo pipefail
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$root" 2>/dev/null || exit 0
[ -f .agent-guard/contract.yaml ] || exit 0
command -v agent-receipt >/dev/null 2>&1 || exit 0
agent-receipt receipt --committed --redact >/dev/null 2>&1 || true
exit 0
`;

// 게이트(pre-commit/pre-push)와 증거(post-commit)를 분리 설치한다.
// 게이트는 --no-verify 로 우회 가능(정상)·증거는 우회에도 남는다.
const HOOKS: Record<string, string> = { "pre-commit": PRE_COMMIT, "pre-push": PRE_PUSH, "post-commit": POST_COMMIT };

function gitConfigGet(key: string): string | null {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * `agent-receipt install-hooks [--force]` — git pre-commit/pre-push 에 commit-check 게이트를 설치한다.
 * - husky / core.hooksPath 사용 중이면 충돌 방지로 설치 거부(exit 2).
 * - 우리가 만들지 않은 기존 hook 은 --force 없이는 덮지 않는다(보존).
 * core.hooksPath 를 건드리지 않는다(기존 hook 시스템과 비충돌). 항상 process.exit.
 */
export function runInstallHooks(force: boolean): never {
  const root = g.repoRoot();
  if (!root) {
    console.error("git 저장소가 아님 — 저장소 루트에서 실행하세요.");
    process.exit(2);
  }

  const hooksPath = gitConfigGet("core.hooksPath");
  if (hooksPath && hooksPath !== ".git/hooks") {
    console.error(`core.hooksPath 가 '${hooksPath}' 로 설정돼 있어 .git/hooks 설치가 무력화됩니다(예: husky).`);
    console.error(`  → '${hooksPath}/' 에 'agent-receipt commit-check' 를 직접 추가하거나 core.hooksPath 해제 후 다시.`);
    process.exit(2);
  }
  if (existsSync(join(root, ".husky"))) {
    console.error(".husky/ 가 있습니다(husky 사용 중) — 충돌 방지로 설치를 중단합니다.");
    console.error("  → .husky/pre-commit 등에 'agent-receipt commit-check' 를 직접 추가하세요.");
    process.exit(2);
  }

  const dir = join(root, ".git", "hooks");
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, body] of Object.entries(HOOKS)) {
    const out = join(dir, name);
    if (existsSync(out) && !readFileSync(out, "utf8").includes(MARKER) && !force) {
      skipped.push(name); // 남의 hook 보존 — --force 없이는 덮지 않음
      continue;
    }
    writeFileSync(out, body);
    chmodSync(out, 0o755);
    written.push(name);
  }

  for (const n of written) console.log(`설치됨(+x): .git/hooks/${n}`);
  for (const n of skipped) console.error(`건너뜀(기존 hook 보존 — 덮으려면 --force): .git/hooks/${n}`);
  console.log("");
  console.log("게이트(pre-commit·pre-push)=commit-check — 위반 시 차단·검토 후 --no-verify 로 우회 가능.");
  console.log("증거(post-commit)=receipt --committed — 방금 만든 커밋의 영수증. --no-verify 우회에도 남습니다(게이트와 분리).");
  console.log("Stop hook(세션 종료시 자동 receipt)은 git hook 이 아니라 에이전트 설정에 등록하세요(README 참고).");
  console.log("우회: git commit --no-verify / git push --no-verify     제거: agent-receipt uninstall-hooks");
  process.exit(skipped.length ? 1 : 0);
}

/** `agent-receipt uninstall-hooks` — install-hooks 가 만든 hook 만 제거(남의 hook 은 보존). */
export function runUninstallHooks(): never {
  const root = g.repoRoot();
  if (!root) {
    console.error("git 저장소가 아님.");
    process.exit(2);
  }
  const dir = join(root, ".git", "hooks");
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of Object.keys(HOOKS)) {
    const out = join(dir, name);
    if (!existsSync(out)) continue;
    if (readFileSync(out, "utf8").includes(MARKER)) {
      rmSync(out);
      removed.push(name);
    } else {
      kept.push(name);
    }
  }
  for (const n of removed) console.log(`제거됨: .git/hooks/${n}`);
  for (const n of kept) console.error(`보존(agent-receipt 가 만든 hook 이 아님): .git/hooks/${n}`);
  if (!removed.length && !kept.length) console.log("제거할 agent-receipt hook 이 없습니다.");
  process.exit(0);
}
