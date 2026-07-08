// tap CLI e2e — install(미리보기 기본·멱등·--except 선언 제외)·sidecar 정본 복원·status/show/verify·probe 스모크.
import assert from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const dir = mkdtempSync(join(tmpdir(), "tapcli-"));
// 가짜 MCP 서버(모든 id 에 initialize 형태로 응답)
const fake = join(dir, "fake.mjs");
writeFileSync(
  fake,
  [
    'process.stdout.on("error", () => process.exit(0));',
    'let buf = "";',
    'process.stdin.on("data", (d) => {',
    '  buf += d.toString("utf8");',
    "  let i;",
    '  while ((i = buf.indexOf("\\n")) !== -1) {',
    "    const line = buf.slice(0, i); buf = buf.slice(i + 1);",
    "    try { const m = JSON.parse(line); if (m.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: \"2.0\", id: m.id, result: { protocolVersion: \"2025-06-18\", ok: true } }) + \"\\n\"); } catch {}",
    "  }",
    "});",
    'process.stdin.on("end", () => setTimeout(() => process.exit(0), 20));',
  ].join("\n"),
);
const origServers = {
  alpha: { command: process.execPath, args: [fake] },
  beta: { command: process.execPath, args: [fake], env: { BETA_KEY: "beta-secret-val" } },
  web: { url: "https://example.com/mcp" },
};
const cfgPath = join(dir, ".mcp.json");
writeFileSync(cfgPath, JSON.stringify({ mcpServers: origServers }, null, 2) + "\n");
const origBytes = readFileSync(cfgPath, "utf8");

// ── 미리보기 기본: 설정 불변 ──
{
  const r = cli(dir, "tap", "install");
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("미리보기"), "기본=미리보기");
  assert.equal(readFileSync(cfgPath, "utf8"), origBytes, "미리보기는 파일 무변경");
}

// ── install --write --except beta: alpha 만 감쌈·beta 는 선언된 제외·web(url)은 범위 밖 ──
{
  const r = cli(dir, "tap", "install", "--write", "--except", "beta");
  assert.equal(r.code, 0);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const a = cfg.mcpServers.alpha;
  assert.equal(a.command, process.execPath, "node 절대경로로 감쌈");
  assert.ok(a.args.includes("mcp-tap"), "mcp-tap 배선");
  const ld = a.args[a.args.indexOf("--log-dir") + 1];
  assert.equal(ld, join(dir, ".agent-guard", "tap"), "절대 log-dir 굽기(결정 2)");
  const sepIdx = a.args.indexOf("--");
  assert.deepEqual(a.args.slice(sepIdx + 1), [process.execPath, fake], "원본 커맨드 보존");
  assert.deepEqual(cfg.mcpServers.beta, origServers.beta, "--except 는 무변경");
  assert.deepEqual(cfg.mcpServers.web, origServers.web, "url 서버는 v1 범위 밖");
  const sidecar = JSON.parse(readFileSync(join(dir, ".agent-guard", "tap", "wrapped.json"), "utf8"));
  assert.equal(sidecar.entries.length, 1);
  assert.equal(sidecar.entries[0].serverName, "alpha");
  assert.deepEqual(sidecar.entries[0].original, { command: process.execPath, args: [fake] }, "복원 정본=sidecar(결정 3)");
  assert.deepEqual(sidecar.excluded, [{ configPath: cfgPath, serverName: "beta" }], "침묵 없는 제외");
  assert.ok(!JSON.stringify(sidecar).includes("beta-secret-val"), "env 값은 sidecar 에도 없음(결정 5)");
}

// ── 멱등: 두 번째 install --write 는 무변화 ──
{
  const before = readFileSync(cfgPath, "utf8");
  const r = cli(dir, "tap", "install", "--write", "--except", "beta");
  assert.equal(r.code, 0);
  assert.ok(r.out.includes("이미 감쌈"), "멱등 감지");
  assert.equal(readFileSync(cfgPath, "utf8"), before, "재실행 무변화");
}

// ── probe: 감싼 체인(tap 경유)으로 initialize 왕복 ──
{
  const r = cli(dir, "tap", "probe");
  assert.equal(r.code, 0, "probe 성공: " + r.out);
  assert.ok(r.out.includes("alpha") && r.out.includes("✅"), "핸드셰이크 성공 보고");
}

// ── 실사용 1회(감싼 커맨드 직접 spawn) → status/show/verify ──
{
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const a = cfg.mcpServers.alpha;
  const child = spawn(a.command, a.args, { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString("utf8")));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/x" } } }) + "\n");
  const t0 = Date.now();
  while (!out.includes('"id":1') && Date.now() - t0 < 8000) await sleep(30);
  child.stdin.end();
  await new Promise((r) => child.on("exit", r));

  const st = cli(dir, "tap", "status");
  assert.equal(st.code, 0);
  assert.ok(st.out.includes("감싼 서버: 1건") && st.out.includes("alpha"), "status: sidecar 요약");
  assert.ok(st.out.includes("선언된 제외: beta"), "status: 제외 표기");
  assert.ok(st.out.includes("정상 종료"), "status: 클린 종료 로그 인식");

  const sh = cli(dir, "tap", "show", "--by", "class");
  assert.ok(sh.out.includes("fs-read"), "show: 클래스 카운트");

  const v = cli(dir, "tap", "verify");
  assert.equal(v.code, 0, "verify green: " + v.out);
  assert.ok(v.out.includes("체인 무결"));

  // 변조 후 verify 는 exit 1
  const logDir = join(dir, ".agent-guard", "tap");
  const lf = readdirSync(logDir).find((f) => f.startsWith("alpha-") && f.endsWith(".jsonl"));
  const p = join(logDir, lf);
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[0]);
  rec.server = { ...rec.server, name: "EVIL" };
  lines[0] = JSON.stringify(rec);
  writeFileSync(p, lines.join("\n") + "\n");
  const v2 = cli(dir, "tap", "verify");
  assert.equal(v2.code, 1, "변조 시 exit 1");
  writeFileSync(p, ""); // 뒤 시나리오 오염 방지(변조 파일 비움)
}

// ── uninstall: 미리보기 → --write 정확 복원 ──
{
  const pre = cli(dir, "tap", "uninstall");
  assert.equal(pre.code, 0);
  assert.ok(pre.out.includes("미리보기"));
  const r = cli(dir, "tap", "uninstall", "--write");
  assert.equal(r.code, 0);
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepEqual(cfg.mcpServers.alpha, origServers.alpha, "원본 정확 복원");
  const sidecar = JSON.parse(readFileSync(join(dir, ".agent-guard", "tap", "wrapped.json"), "utf8"));
  assert.equal(sidecar.entries.length, 0, "sidecar 기록 정리");
}

console.log("tap-cli: OK (미리보기·감쌈·멱등·선언 제외·probe·status/show/verify·정확 복원)");
