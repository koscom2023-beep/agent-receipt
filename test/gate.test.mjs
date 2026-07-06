// R9 검사 실패 = 행위 중단 배선 테스트 — 순수 판정 + CLI exit 코드(행위중단/허용/도구오류) + 훅 deny.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateDecision } from "../dist/gate.js";

// 순수 판정
assert.equal(gateDecision({ kind: "verification-receipt", verdict: "fail", surface: "bench", subject: "x" }).block, true, "fail=block");
assert.equal(gateDecision({ kind: "verification-receipt", verdict: "pass" }).block, false, "pass=allow");
assert.equal(gateDecision({ kind: "verification-receipt", verdict: "abstain" }).block, false, "abstain=allow");
assert.ok(gateDecision({ verdict: "fail" }).reason.includes("검증 실패"), "block 사유");

// CLI exit 코드 — 검사 실패=행위 중단 배선
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const failR = join(tmpdir(), `ar-gate-fail-${process.pid}.json`);
const passR = join(tmpdir(), `ar-gate-pass-${process.pid}.json`);
writeFileSync(failR, JSON.stringify({ kind: "verification-receipt", verdict: "fail", surface: "bench", subject: "bad" }));
writeFileSync(passR, JSON.stringify({ kind: "verification-receipt", verdict: "pass", surface: "bench", subject: "good" }));

assert.equal(spawnSync("node", [cli, "gate", "--receipt", failR], { input: "" }).status, 1, "fail=행위중단 exit1");
assert.equal(spawnSync("node", [cli, "gate", "--receipt", passR], { input: "" }).status, 0, "pass=허용 exit0");

// 훅 모드: fail → 벤더 deny JSON stdout·exit0
const hook = spawnSync("node", [cli, "gate", "--receipt", failR, "--hook", "--vendor", "claude"], { encoding: "utf8", input: "" });
assert.equal(hook.status, 0, "훅 exit0");
const deny = JSON.parse(hook.stdout);
assert.equal(deny.hookSpecificOutput.permissionDecision, "deny", "훅 PreToolUse deny 방출(행위 차단)");

// 훅 모드 pass → 무출력 허용
const hookPass = spawnSync("node", [cli, "gate", "--receipt", passR, "--hook", "--vendor", "claude"], { encoding: "utf8", input: "" });
assert.equal(hookPass.status, 0);
assert.equal(hookPass.stdout.trim(), "", "통과=무출력 허용");

// 도구 오류(파일없음) = non-block exit2(검증 실패 아님)
assert.equal(spawnSync("node", [cli, "gate", "--receipt", join(tmpdir(), "nope-xyz.json")], { input: "" }).status, 2, "도구오류=exit2(non-block)");

console.log("gate.test: OK — 검사 실패=행위중단(CLI exit1·훅 deny)·통과=허용·도구오류=non-block(fail-open 정신)");
