// 루프 개입(evalLoopGuard) — council 2026-07-03 L1~L2 수락 기준.
// 신호=동일 명령 재실행+사이 파일변경 0+같은 세션 · 대상 test/build/lint · 이중 opt-in · 기본 warn.
// `node test/loop-guard.test.mjs`.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { evalLoopGuard } from "../dist/guard.js";

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

const CLI = join(process.cwd(), "dist", "cli.js");
const CMD = "npx vitest run src/";
const HASH = createHash("sha256").update(CMD).digest("hex").slice(0, 16);

const mkRepo = (policyBody, capLines) => {
  const d = mkdtempSync(join(tmpdir(), "ar-loop-"));
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  if (policyBody) writeFileSync(join(d, ".agent-guard", "policy.yaml"), policyBody);
  if (capLines) writeFileSync(join(d, ".agent-guard", "capture.jsonl"), capLines.map((o) => JSON.stringify(o)).join("\n") + "\n");
  return d;
};
const cmdRec = (sessionId = "s1", phase = "pre") => ({ ts: "T", phase, tool: "Bash", op: "command", cmdHash: HASH, cmdKind: "test", sessionId });
const writeRec = (sessionId = "s1") => ({ ts: "T", phase: "pre", tool: "Edit", op: "write", path: "src/a.ts", sessionId });
const target = { op: "command", cmdHash: HASH, cmdKind: "test" };

check("임계 미설정 → none (완전 off·capture 파일 있어도)", () => {
  const d = mkRepo(`guard: block\n`, [cmdRec(), cmdRec()]);
  assert.equal(evalLoopGuard(target, "s1", d).action, "none");
});

check("동일 test 명령 3회째(쓰기 0·같은 세션)+block → deny + 휴리스틱 자백 + 해제 안내", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec(), cmdRec()]);
  const v = evalLoopGuard(target, "s1", d);
  assert.equal(v.action, "deny");
  assert.ok(v.reason.includes("conservative heuristic"), "휴리스틱 자백 문구 없음");
  assert.ok(v.reason.includes("loop_repeat_threshold"), "해제 안내 없음");
  assert.equal(v.rule, "loop:testx3-no-change");
});

check("guard 미지정(기본 warn)+임계 → warn (차단 아님)", () => {
  const d = mkRepo(`loop_repeat_threshold: 3\n`, [cmdRec(), cmdRec()]);
  const v = evalLoopGuard(target, "s1", d);
  assert.equal(v.action, "warn");
});

check("사이에 쓰기 → 창 리셋 (트리거 안 함)", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec(), cmdRec(), writeRec(), cmdRec()]);
  // 쓰기 이후 동일 명령 1회뿐 → 이번이 2회째 < 3
  assert.equal(evalLoopGuard(target, "s1", d).action, "none");
});

check("다른 세션의 실행/쓰기는 카운트·경계 불산입", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec("s2"), cmdRec("s2"), cmdRec("s1"), writeRec("s2"), cmdRec("s1")]);
  // s1 기준: 쓰기(s2)는 경계 아님 → s1 동일명령 2회 → 이번이 3회째 → deny
  assert.equal(evalLoopGuard(target, "s1", d).action, "deny");
});

check("sessionId 없으면 개입 안 함(보수적)", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec(), cmdRec()]);
  assert.equal(evalLoopGuard(target, undefined, d).action, "none");
});

check("cmdKind other(git status류) → 임계 있어도 면제", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 2\n`, [
    { ts: "T", phase: "pre", tool: "Bash", op: "command", cmdHash: "aaaa111122223333", cmdKind: "other", sessionId: "s1" },
  ]);
  assert.equal(evalLoopGuard({ op: "command", cmdHash: "aaaa111122223333", cmdKind: "other" }, "s1", d).action, "none");
});

check("post 이중기록은 카운트 제외(pre 만)", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec("s1", "pre"), cmdRec("s1", "post")]);
  // pre 1회뿐 → 이번이 2회째 < 3
  assert.equal(evalLoopGuard(target, "s1", d).action, "none");
});

check("CLI 통합: capture pre 가 3회째 동일 명령에 deny JSON 방출 + 레코드 guard=deny", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec(), cmdRec()]);
  const r = spawnSync("node", [CLI, "capture", "--event", "pre"], {
    cwd: d,
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: CMD }, session_id: "s1" }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const recs = readFileSync(join(d, ".agent-guard", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hit = recs.find((x) => x.guard === "deny" && String(x.guardRule || "").startsWith("loop:"));
  assert.ok(hit, "loop deny 레코드 없음");
});

check("깨진 capture 라인 → 무시하고 계속(fail-open)", () => {
  const d = mkRepo(`guard: block\nloop_repeat_threshold: 3\n`, [cmdRec()]);
  const f = join(d, ".agent-guard", "capture.jsonl");
  writeFileSync(f, readFileSync(f, "utf8") + "{broken json\n" + JSON.stringify(cmdRec()) + "\n");
  const v = evalLoopGuard(target, "s1", d);
  assert.equal(v.action, "deny"); // 유효 2회 + 이번 = 3
});

console.log(`loop-guard.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
