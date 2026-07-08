// mcp-tap 세션 경계·영수증 통합 — I7(커서 창 비중첩)·coverage(결정 10)·해시 불변(I1)·판정 격리(I6).
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TapLog, tapCursorSnapshot, buildTapSummary, serverConfigHash } from "../dist/tap.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function mkCall(log, cls = ["fs-read"], server = "alpha") {
  log.append({
    schemaVersion: "tap/1", kind: "call", seq: log.nextSeq(), ts: "T", server,
    rpc: { id: "x", method: "tools/call" }, tool: { name: "read_file", argsDigest: "sha256:a" },
    result: { status: "ok" }, class: cls,
  });
}

// ── I7: 한 로그 위 begin/done 2회 → 창 비중첩·합계 일치 ──
{
  const cwd = mkdtempSync(join(tmpdir(), "tapwin-"));
  const dir = join(cwd, ".agent-guard", "tap");
  mkdirSync(dir, { recursive: true });
  const log = new TapLog(dir, "alpha-1.jsonl");
  for (let i = 0; i < 10; i++) mkCall(log);
  await log.drain();

  tapCursorSnapshot(cwd); // begin #1 경계
  const s0 = buildTapSummary(cwd);
  assert.equal(s0, null, "커서 직후=창 비어있음(null → 영수증 키 부재)");

  for (let i = 0; i < 7; i++) mkCall(log);
  await log.drain();
  const s1 = buildTapSummary(cwd);
  assert.equal(s1.calls, 7, "창 1=커서 이후 7건만(이전 10건 이중 계상 없음)");
  const w1 = s1.window["alpha-1.jsonl"];
  assert.equal(w1.fromSeq, 10);
  assert.equal(w1.toSeq, 16);

  tapCursorSnapshot(cwd); // begin #2 경계
  for (let i = 0; i < 5; i++) mkCall(log);
  await log.drain();
  const s2 = buildTapSummary(cwd);
  assert.equal(s2.calls, 5, "창 2=새 5건만");
  const w2 = s2.window["alpha-1.jsonl"];
  assert.equal(w2.fromSeq, 17);
  assert.equal(w2.toSeq, 21);
  assert.ok(w1.toSeq < w2.fromSeq, "I7: 창 비중첩");

  // coverage: sidecar 기대치·선언 제외·드리프트
  const cfgPath = join(cwd, ".mcp.json");
  const alphaEntry = { command: "node", args: ["srv.mjs"] };
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { alpha: alphaEntry, beta: { command: "node", args: ["b.mjs"] } } }, null, 2));
  const sidecar = {
    version: 1,
    entries: [
      { configPath: cfgPath, serverName: "alpha", original: alphaEntry, configHash: serverConfigHash(alphaEntry), logDir: dir },
      { configPath: cfgPath, serverName: "beta", original: { command: "node", args: ["b.mjs"] }, configHash: serverConfigHash({ command: "node", args: ["b.mjs"] }), logDir: dir },
    ],
    excluded: [{ configPath: cfgPath, serverName: "gamma" }],
    unwrapped: [{ configPath: cfgPath, serverName: "remote", reason: "transport-http" }],
  };
  writeFileSync(join(dir, "wrapped.json"), JSON.stringify(sidecar, null, 2));
  const s3 = buildTapSummary(cwd);
  assert.deepEqual(s3.coverage.expectedServers, ["alpha", "beta"], "기대치 정본=sidecar(결정 10)");
  assert.deepEqual(s3.coverage.missing, ["beta"], "창 내 기록 없음=사실 신호");
  assert.deepEqual(s3.coverage.excluded, ["gamma"], "침묵 없는 제외");
  assert.deepEqual(s3.coverage.unwrapped, ["remote(transport-http)"], "감쌀 수 없음 자백(수요 실측 데이터 겸용)");
  assert.deepEqual(s3.coverage.configDrift, [], "설정 불변=드리프트 없음");
  // 설정 변조 → 드리프트
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { alpha: { command: "node", args: ["EVIL.mjs"] }, beta: { command: "node", args: ["b.mjs"] } } }, null, 2));
  assert.deepEqual(buildTapSummary(cwd).coverage.configDrift, ["alpha"], "install 시점과 다름=드리프트 자백");
}

// ── I1+I6: 실제 영수증에서 tapSummary=additive·contentHash 불변·판정 비유입 ──
{
  const repo = mkdtempSync(join(tmpdir(), "tapwin-repo-"));
  const sh = (cmd, args) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8" });
  sh("git", ["init", "-q"]);
  sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  const r0 = sh(process.execPath, [CLI, "init", "--preset", "generic"]);
  assert.equal(r0.status, 0, "init: " + r0.stdout + r0.stderr);
  writeFileSync(join(repo, "work.txt"), "hello\n");

  // tap 로그 심기(커서 없음=전체가 창) — publish 클래스 포함(warn-only 표면 확인용)
  const tdir = join(repo, ".agent-guard", "tap");
  mkdirSync(tdir, { recursive: true });
  const log = new TapLog(tdir, "alpha-9.jsonl");
  mkCall(log, ["publish"]);
  mkCall(log, ["fs-read"]);
  await log.drain();

  const d1 = sh(process.execPath, [CLI, "done"]);
  assert.ok(d1.stdout.includes("tap 관측: 호출 2"), "done 에 tap 사실 1줄: " + d1.stdout.split("\n").find((l) => l.includes("tap")));
  const recDir = join(repo, ".agent-guard", "receipts");
  const j1 = JSON.parse(readFileSync(join(recDir, readdirSync(recDir).filter((f) => f.endsWith(".json")).sort().pop()), "utf8"));
  assert.ok(j1.tapSummary, "영수증에 tapSummary 동승");
  assert.equal(j1.tapSummary.calls, 2);
  const verdict1 = j1.verdict?.verdict;
  const hash1 = j1.contentHash;

  // tap 제거 후 재실행 → contentHash·판정 동일(I1·I6)
  rmSync(tdir, { recursive: true, force: true });
  const d2 = sh(process.execPath, [CLI, "done"]);
  assert.ok(!d2.stdout.includes("tap 관측"), "tap 없으면 출력 불변");
  const j2 = JSON.parse(readFileSync(join(recDir, readdirSync(recDir).filter((f) => f.endsWith(".json")).sort().pop()), "utf8"));
  assert.equal(j2.tapSummary, undefined, "키 부재(additive)");
  assert.equal(j2.contentHash, hash1, "I1: tapSummary 는 receiptHash 입력 제외 — 해시 불변");
  assert.equal(j2.verdict?.verdict, verdict1, "I6: 판정에 tap 비유입(동일 판정)");
}

console.log("tap-window: OK (I7 커서 비중첩 · coverage/드리프트 · I1 해시불변 · I6 판정격리)");
