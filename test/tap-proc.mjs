// mcp-tap 프로세스 e2e — I2(무수정 중계)·I3(값·env 미저장)·I5(fail-open 구조)·I8(비우호 CWD)·
// exit code 전파·킬 스위치·크래시 자백(shutdown 부재). 가짜 MCP 서버는 테스트가 직접 생성(자체완결).
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTapFile } from "../dist/tap.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 10000, step = 40) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error("waitFor 시간초과: " + what);
    await sleep(step);
  }
}

function makeFakeServer(dir) {
  const p = join(dir, "fake-server.mjs");
  writeFileSync(
    p,
    [
      'import { appendFileSync } from "node:fs";',
      'process.stdout.on("error", () => process.exit(0)); // tap SIGKILL 시나리오: 죽은 파이프 EPIPE 무해 종료',
      "const RECV = process.env.RECV_FILE;",
      'let buf = "";',
      'process.stdin.on("data", (d) => {',
      '  buf += d.toString("utf8");',
      "  let i;",
      '  while ((i = buf.indexOf("\\n")) !== -1) {',
      "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
      '    if (RECV) appendFileSync(RECV, line + "\\n");',
      "    try {",
      "      const m = JSON.parse(line);",
      "      if (m.id !== undefined) {",
      '        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { ok: true, echoBytes: line.length } }) + "\\n");',
      "      }",
      "    } catch {",
      '      process.stdout.write("SERVER-GARBAGE-ECHO\\n");',
      "    }",
      "  }",
      "});",
      'process.stdin.on("end", () => setTimeout(() => process.exit(Number(process.env.EXIT_CODE ?? 0)), 30));',
    ].join("\n"),
  );
  return p;
}

function spawnTap(dir, { env = {}, cwd, server = "fake" } = {}) {
  const logDir = join(dir, "tapdir"); // 절대경로(결정 2)
  const recv = join(dir, "received.log");
  const fake = makeFakeServer(dir);
  const child = spawn(
    process.execPath,
    [CLI, "mcp-tap", "--server-name", server, "--log-dir", logDir, "--config-hash", "sha256:cfg", "--", process.execPath, fake],
    { cwd: cwd ?? dir, env: { ...process.env, RECV_FILE: recv, ...env }, stdio: ["pipe", "pipe", "inherit"] },
  );
  let out = Buffer.alloc(0);
  child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
  const exited = new Promise((res) => child.on("exit", (code, sig) => res({ code, sig })));
  return { child, logDir, recv, stdout: () => out.toString("utf8"), exited };
}

function tapLogFile(logDir, server = "fake") {
  if (!existsSync(logDir)) return null;
  const f = readdirSync(logDir).find((x) => x.startsWith(server + "-") && x.endsWith(".jsonl"));
  return f ? join(logDir, f) : null;
}

// ── 시나리오 1: 무수정 중계(I2) + 레코드 생산 + 값·env 카나리아(I3) + 클린 종료 ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapproc1-"));
  const t = spawnTap(dir, { env: { TAP_ENV_SECRET: "ENV_CANARY_9x" } });
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "v" } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/tmp/PATH_CANARY_7q" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute_sql", arguments: { query: "INSERT INTO t VALUES('VAL_CANARY_3z')" } } }),
    "THIS IS NOT JSON",
  ];
  const sent = lines.map((l) => l + "\n").join("");
  const expectedOut =
    lines
      .slice(0, 3)
      .map((l) => JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(l).id, result: { ok: true, echoBytes: l.length } }) + "\n")
      .join("") + "SERVER-GARBAGE-ECHO\n";

  t.child.stdin.write(sent);
  await waitFor(() => t.stdout() === expectedOut, "서버 응답 수신");
  t.child.stdin.end();
  const { code } = await t.exited;
  assert.equal(code, 0, "정상 종료 전파");

  // I2: 서버가 받은 바이트 == 보낸 바이트(관측이 c2s 를 오염시키지 않음)
  assert.equal(readFileSync(t.recv, "utf8"), sent, "I2: c2s 무수정");
  // s2c 무수정은 expectedOut 비교로 이미 증명(비JSON 에코 포함)

  const lf = tapLogFile(t.logDir);
  assert.ok(lf, "tap 로그 생성");
  const raw = readFileSync(lf, "utf8");
  assert.ok(!raw.includes("PATH_CANARY_7q") && !raw.includes("VAL_CANARY_3z"), "I3: 인자 값 미저장");
  assert.ok(!raw.includes("ENV_CANARY_9x") && !raw.includes("TAP_ENV_SECRET"), "I3: env 미기록(결정 5)");
  const recs = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(recs[0].kind, "tapMeta");
  assert.equal(recs[0].digestAlg, "jcs/sha256");
  assert.equal(recs[0].configHash, "sha256:cfg");
  assert.ok(recs.some((r) => r.kind === "serverInfo"), "initialize 관측");
  const sql = recs.find((r) => r.kind === "call" && r.tool?.name === "execute_sql");
  assert.deepEqual(sql.class, ["db-write"]);
  assert.ok(recs.some((r) => r.kind === "opaque"), "비JSON frame=opaque");
  assert.equal(recs[recs.length - 1].kind, "shutdown", "클린 종료 마커");
  assert.equal(recs[recs.length - 1].clean, true);
  const v = verifyTapFile(lf);
  assert.equal(v.tampered + v.chainBreaks + v.coalesceErrors, 0, "체인 무결");
  assert.equal(v.cleanShutdown, true);
}

// ── 시나리오 2: child exit code 전파 ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapproc2-"));
  const t = spawnTap(dir, { env: { EXIT_CODE: "7" } });
  t.child.stdin.end();
  const { code } = await t.exited;
  assert.equal(code, 7, "child exit code 그대로 전파");
}

// ── 시나리오 3: 킬 스위치 = 순수 중계 + bypass 마커(몰래 우회 없음) ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapproc3-"));
  const t = spawnTap(dir, { env: { AGENT_RECEIPT_TAP_OFF: "1" } });
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } }) + "\n";
  t.child.stdin.write(line);
  await waitFor(() => t.stdout().includes('"id":1'), "킬스위치에서도 중계");
  t.child.stdin.end();
  await t.exited;
  const lf = tapLogFile(t.logDir);
  assert.ok(lf, "bypass 마커 파일");
  const recs = readFileSync(lf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(recs.length, 1, "기록은 bypass 1줄뿐");
  assert.deepEqual(recs[0].markers, ["bypass"]);
}

// ── 시나리오 4(I8): 비우호 CWD(루트 /·비쓰기)에서도 절대 --log-dir 에 기록 ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapproc4-"));
  const t = spawnTap(dir, { cwd: "/" });
  t.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await waitFor(() => t.stdout().includes('"id":1'), "비우호 CWD 중계");
  t.child.stdin.end();
  const { code } = await t.exited;
  assert.equal(code, 0);
  const lf = tapLogFile(t.logDir);
  assert.ok(lf && readFileSync(lf, "utf8").includes("tapMeta"), "I8: favorable-CWD 함정 없음");
}

// ── 시나리오 5: 크래시 자백 — SIGKILL 후 shutdown 레코드 부재 ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapproc5-"));
  const t = spawnTap(dir);
  t.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await waitFor(() => {
    const lf = tapLogFile(t.logDir);
    return lf && readFileSync(lf, "utf8").includes("tapMeta");
  }, "tapMeta 기록");
  t.child.kill("SIGKILL");
  await t.exited;
  await sleep(100);
  const recs = readFileSync(tapLogFile(t.logDir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(!recs.some((r) => r.kind === "shutdown"), "크래시=shutdown 부재(구조적 자백·§11(e))");
}

console.log("tap-proc: OK (무수정 중계·카나리아·킬스위치·비우호 CWD·exit 전파·크래시 자백)");
