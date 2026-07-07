// v0.21 결정10 — 행위 클래스(push/publish/network) 분류 + policy forbid_actions 가드.
// 수용기준(council): 첫 토큰 파스(인자 속 문자열 오탐 0)·opt-in·fail-open·우회가능 자백·분류표 전수.
// `node test/forbid-actions.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEvent } from "../dist/capture.js";
import { evalGuard } from "../dist/guard.js";

let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

const kindOf = (cmd) => {
  const recs = classifyEvent({ tool_name: "Bash", tool_input: { command: cmd } }, "pre", "2026-01-01T00:00:00Z");
  return recs[0]?.op === "command" ? recs[0]?.cmdKind : recs[0]?.op; // URL 감지 시 op=network
};

// ── 분류표 전수(첫 토큰 파스 — 문자열 오탐 차단) ──
const TABLE = [
  ["git push origin main", "push"],
  ["git push", "push"],
  ["FOO=1 git push", "push"], // 선행 ENV= 스킵
  ["npm publish --access public", "publish"],
  ["pnpm publish", "publish"],
  ["yarn publish", "publish"], // CMD_INSTALL(yarn) 오탐 방지 — 토큰 클래스가 우선
  ["curl example.com", "network"],
  ["wget example.com/f.tar", "network"],
  ["ssh host uptime", "network"],
  ['echo "git push"', "other"], // 인자 속 문자열 = 오탐 금지(수용기준)
  ["git pull", "other"],
  ["npm run build", "build"], // 기존 클래스 불변
  ["npx vitest run", "test"],
];
for (const [cmd, want] of TABLE) {
  check(`분류: ${cmd} → ${want}`, () => assert.equal(kindOf(cmd), want));
}

// ── evalGuard × policy.forbid_actions ──
const dir = join(process.env.TMPDIR || "/tmp", `ar-fa-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, ".agent-guard"), { recursive: true });
const setPolicy = (yaml) => writeFileSync(join(dir, ".agent-guard", "policy.yaml"), yaml);

setPolicy("guard: warn\nforbid_actions:\n  - push\n  - network\n");
check("warn 모드: push 명령 = warn + origin=policy.forbid_actions", () => {
  const v = evalGuard({ op: "command", cmdKind: "push" }, dir);
  assert.deepEqual({ action: v.action, origin: v.origin }, { action: "warn", origin: "policy.forbid_actions" });
  assert.equal(v.rule, "policy.forbid_actions:push");
});
check("목록 밖 클래스(test) = none(opt-in 한정)", () => {
  assert.equal(evalGuard({ op: "command", cmdKind: "test" }, dir).action, "none");
});
check("network op(URL 이벤트)도 대조", () => {
  assert.equal(evalGuard({ op: "network" }, dir).action, "warn");
});

setPolicy("guard: block\nforbid_actions:\n  - publish\n");
check("block 모드: publish = deny + 우회가능 자백 + 해제 경로", () => {
  const v = evalGuard({ op: "command", cmdKind: "publish" }, dir);
  assert.equal(v.action, "deny");
  assert.ok(v.reason.includes("signal, not a lock"), "우회가능 자백");
  assert.ok(v.reason.includes("forbid_actions"), "해제 경로 안내");
});
check("block 이어도 목록 밖(push) = none", () => {
  assert.equal(evalGuard({ op: "command", cmdKind: "push" }, dir).action, "none");
});

setPolicy("forbid_actions: [broken\n");
check("깨진 policy = fail-open(none)", () => {
  assert.equal(evalGuard({ op: "command", cmdKind: "push" }, dir).action, "none");
});
check("policy 없음 = none(기본 완전 off)", () => {
  rmSync(join(dir, ".agent-guard", "policy.yaml"));
  assert.equal(evalGuard({ op: "command", cmdKind: "push" }, dir).action, "none");
});

rmSync(dir, { recursive: true, force: true });
if (fail.length) {
  console.error(`forbid-actions.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`forbid-actions.test: OK (${pass}) — 분류표 전수(오탐 0)·opt-in warn/deny·자백·fail-open`);
