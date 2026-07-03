// 실시간 스코프 가드(guard.ts) — council 2026-07-03 수락 기준.
// `node test/guard.test.mjs`. 유닛(evalGuard) + CLI(capture pre stdin → deny JSON/기록) + 체인 유효.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evalGuard } from "../dist/guard.js";
import { verifyCaptureChain } from "../dist/capture.js";

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
const mkTmp = () => mkdtempSync(join(tmpdir(), "ar-guard-"));
const writePolicy = (dir, body) => {
  mkdirSync(join(dir, ".agent-guard"), { recursive: true });
  writeFileSync(join(dir, ".agent-guard", "policy.yaml"), body);
};

// ── 유닛: evalGuard ──
check("정책/계약 없음 → none (기존 동작 불변)", () => {
  const d = mkTmp();
  assert.equal(evalGuard({ op: "write", path: "secrets/x.txt" }, d).action, "none");
});

check("forbidAlways 매치 + 기본(warn 미명시) → warn (차단 아님)", () => {
  const d = mkTmp();
  writePolicy(d, `forbidAlways:\n  - "secrets/**"\n`);
  const v = evalGuard({ op: "write", path: "secrets/x.txt" }, d);
  assert.equal(v.action, "warn");
  assert.equal(v.rule, "secrets/**");
  assert.equal(v.origin, "policy.forbidAlways");
});

check("guard: block + forbidAlways 매치 → deny + 이유(재시도 금지·해제 경로)", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - ".env*"\n`);
  const v = evalGuard({ op: "write", path: ".env.local" }, d);
  assert.equal(v.action, "deny");
  assert.ok(v.reason.includes("Do NOT retry"), "재시도 금지 문구 없음");
  assert.ok(v.reason.includes("guard: warn"), "해제 경로 안내 없음");
});

check("read 는 대상 아님 — block 이어도 none", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - ".env*"\n`);
  assert.equal(evalGuard({ op: "read", path: ".env" }, d).action, "none");
});

check("계약 denied_paths 매치 → origin=contract (policy 없어도 warn)", () => {
  const d = mkTmp();
  mkdirSync(join(d, ".agent-guard"), { recursive: true });
  writeFileSync(
    join(d, ".agent-guard", "contract.yaml"),
    `id: t1\nscope:\n  allowed_paths: ["src/**"]\n  denied_paths: ["db/**"]\n`,
  );
  const v = evalGuard({ op: "write", path: "db/schema.sql" }, d);
  assert.equal(v.action, "warn");
  assert.equal(v.origin, "contract.denied_paths");
});

check("깨진 policy.yaml → none (fail-open — 차단으로 세션 멈춤 금지)", () => {
  const d = mkTmp();
  writePolicy(d, `guard: [broken\n  yaml::`);
  assert.equal(evalGuard({ op: "write", path: ".env" }, d).action, "none");
});

check("절대경로(실훅 payload) → cwd 상대 정규화 후 매치 — E2E 실측 버그 회귀", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  const v = evalGuard({ op: "write", path: join(d, "secrets", "token.txt") }, d);
  assert.equal(v.action, "deny", "절대경로 미매치(차단 실패 버그 재발)");
});

check("cwd 밖 절대경로 → none (프로젝트 패턴 범위 밖)", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  assert.equal(evalGuard({ op: "write", path: "/etc/secrets/x" }, d).action, "none");
});

check("매치 없는 경로 → none", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  assert.equal(evalGuard({ op: "write", path: "src/app.ts" }, d).action, "none");
});

// ── CLI: capture pre (훅 경로 그대로) ──
const runIngest = (dir, toolInput) =>
  spawnSync("node", [CLI, "capture", "--event", "pre"], {
    cwd: dir,
    input: JSON.stringify({ tool_name: "Write", tool_input: toolInput, session_id: "guard-test" }),
    encoding: "utf8",
  });

check("CLI block: stdout 에 permissionDecision=deny + exit 0 + 레코드 guard=deny", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  const r = runIngest(d, { file_path: "secrets/token.txt", content: "x" });
  assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes("secrets/**"));
  const recs = readFileSync(join(d, ".agent-guard", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hit = recs.find((x) => x.guard === "deny");
  assert.ok(hit, "guard=deny 레코드 없음");
  assert.equal(hit.guardRule, "policy.forbidAlways:secrets/**");
});

check("CLI warn(기본): stdout 없음(행동 불변) + 레코드 guard=warn 기록", () => {
  const d = mkTmp();
  writePolicy(d, `forbidAlways:\n  - "secrets/**"\n`);
  const r = runIngest(d, { file_path: "secrets/token.txt", content: "x" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "warn 모드가 stdout 을 방출함(harness 오염)");
  const recs = readFileSync(join(d, ".agent-guard", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(recs.find((x) => x.guard === "warn"), "guard=warn 레코드 없음");
});

check("CLI 정책 없음: stdout 없음 + guard 필드 자체가 없음(byte-invariant)", () => {
  const d = mkTmp();
  const r = runIngest(d, { file_path: "anything/file.txt", content: "x" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
  const recs = readFileSync(join(d, ".agent-guard", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(recs.every((x) => !("guard" in x) && !("guardRule" in x)), "정책 없는데 guard 필드 존재");
});

check("가드 필드 포함 레코드의 체인 검증 green (해시에 present-only 포함)", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  runIngest(d, { file_path: "secrets/a.txt", content: "x" });
  runIngest(d, { file_path: "src/ok.txt", content: "x" });
  const recs = readFileSync(join(d, ".agent-guard", "capture.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const { problems, verified } = verifyCaptureChain(recs);
  assert.equal(problems.length, 0, `체인 문제: ${problems.join("; ")}`);
  assert.equal(verified, recs.length);
});

check("가드 판정 변조(deny→warn) 시 체인 검증이 잡아냄", () => {
  const d = mkTmp();
  writePolicy(d, `guard: block\nforbidAlways:\n  - "secrets/**"\n`);
  runIngest(d, { file_path: "secrets/a.txt", content: "x" });
  const f = join(d, ".agent-guard", "capture.jsonl");
  const recs = readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  recs[0].guard = "warn"; // 변조
  const { problems } = verifyCaptureChain(recs);
  assert.ok(problems.length > 0, "변조 미탐지");
});

// ── strict 프로필 ──
check("policy init --profile strict → guard: block + secrets 패턴", () => {
  const d = mkTmp();
  const r = spawnSync("node", [CLI, "policy", "init", "--profile", "strict"], { cwd: d, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const body = readFileSync(join(d, ".agent-guard", "policy.yaml"), "utf8");
  assert.ok(body.includes("guard: block"));
  assert.ok(body.includes("secrets/**"));
  assert.ok(existsSync(join(d, ".agent-guard", "policy.yaml")));
});

console.log(`guard.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
