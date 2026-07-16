// P0-3.5 (정본 2026-07-16): session 출처 필드 + 비파괴 관찰 창을 실제 CLI 로 실측한다.
//
// 왜 통합인가: createdByCommand 가 begin/start 로 정확히 박히는지, begin 이 과거 capture 를
// 삭제하지 않는지(비파괴), 옛 기록이 seq 경계로 stale 처리되는지는 실제 파일·실제 명령으로만 증명된다.
// 이 조사가 밝힌 진범: promptia 의 7/15 세션은 begin 이 아니라 start(또는 비-begin)로 생겼고,
//   capture.jsonl 이 7/3 mtime 으로 살아남은 것이 그 증거였다. begin 이었다면 옛 reset 이 지웠을 것이다.
//   출처 필드가 없어 파일만으로는 확정 못 했다 — 그 필드를 지금 추가한다.
//
// run-fixtures / close-recon 패턴 계승: OS tmpdir 격리 repo + 실제 CLI 서브프로세스.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");

if (!existsSync(tsxBin)) {
  console.error(`ENV ERROR: tsx 없음 (${tsxBin}). 먼저 'npm install'.`);
  process.exit(1);
}

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: mkdtempSync(join(tmpdir(), "ag-prov-home-")), // 전역 훅 격리(관찰 배선 오염 방지)
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  AGENT_RECEIPT_NO_NET: "1",
  NO_COLOR: "1",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: ENV,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function run(cwd: string, command: string, args: string[] = []): { status: number | null; stdout: string } {
  const res = spawnSync(tsxBin, [cli, command, ...args], { cwd, env: ENV, encoding: "utf8" });
  if (res.error) throw new Error(`${command} spawn 실패: ${res.error.message}`);
  return { status: res.status, stdout: res.stdout ?? "" };
}

function repo(): string {
  const base = mkdtempSync(join(tmpdir(), "ag-prov-"));
  const r = join(base, "repo");
  mkdirSync(join(r, "src"), { recursive: true });
  git(r, ["init", "-q"]);
  git(r, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(r, "src", "app.ts"), "export const a = 1;\n");
  mkdirSync(join(r, ".agent-guard"), { recursive: true });
  writeFileSync(join(r, ".agent-guard", "contract.yaml"), ["id: t", "title: t", "mode: patch_only", "scope:", "  allowed_paths:", '    - "src/**"', "  denied_paths:", '    - ".env*"', ""].join("\n"));
  git(r, ["add", "-A"]);
  git(r, ["commit", "-qm", "base"]);
  return r;
}

// capture 훅을 프로젝트 settings 에 배선한다(detectWiring 이 CAPTURE_COMMAND_PREFIX 로 감지).
// 실제로 기록이 존재하려면 훅이 배선돼 있어야 하므로, OBSERVED 시나리오는 이 배선을 전제로 실측한다.
function wireHook(r: string): void {
  mkdirSync(join(r, ".claude"), { recursive: true });
  const hook = { hooks: { PostToolUse: [{ hooks: [{ command: "agent-receipt capture --event post" }] }] } };
  writeFileSync(join(r, ".claude", "settings.json"), JSON.stringify(hook, null, 2) + "\n");
}

// 옛 capture 2건을 심는다(seq 1,2 · 오래된 ts). 실제 훅이 쓰는 형식과 동형(관찰 리더가 seq 로 읽는다).
function seedOldCapture(r: string): void {
  const cap = join(r, ".agent-guard", "capture.jsonl");
  const rec = (seq: number, ts: string) => JSON.stringify({ ts, phase: "post", tool: "Write", op: "write", path: "old.txt", sessionId: "old-probe", seq });
  writeFileSync(cap, rec(1, "2026-07-03T03:00:00.000Z") + "\n" + rec(2, "2026-07-03T04:00:00.000Z") + "\n");
}

// 새 행동 1건을 seq 3 으로 추가(begin/start 이후 = 이번 세션 관찰이어야 함).
function appendNewAction(r: string): void {
  const cap = join(r, ".agent-guard", "capture.jsonl");
  appendFileSync(cap, JSON.stringify({ ts: "2026-07-16T10:00:00.000Z", phase: "post", tool: "Edit", op: "write", path: "src/app.ts", sessionId: "now", seq: 3 }) + "\n");
}

function loadSession(r: string): any {
  return JSON.parse(readFileSync(join(r, ".agent-guard", "session.json"), "utf8"));
}
function captureLines(r: string): number {
  const cap = join(r, ".agent-guard", "capture.jsonl");
  return existsSync(cap) ? readFileSync(cap, "utf8").split("\n").filter(Boolean).length : 0;
}

// ── 성공조건 1: 옛 capture 2건 + start → 옛 기록 보존, 현재 창 관찰 0, stale 2, createdByCommand=start ──
{
  const r = repo();
  seedOldCapture(r);
  const res = run(r, "start", ["--contract", join(r, ".agent-guard", "contract.yaml")]);
  assert.equal(res.status, 0, "#1 start 성공");
  assert.equal(captureLines(r), 2, "#1 start 는 과거 capture 를 삭제하지 않는다(비파괴)");
  const s = loadSession(r);
  assert.equal(s.createdByCommand, "start", "#1 createdByCommand=start");
  assert.equal(s.captureBoundary.seq, 2, "#1 경계 seq=2(옛 기록 2건 이하)");
  assert.ok(s.toolVersion && /\d/.test(s.toolVersion), "#1 toolVersion 기록");
  assert.ok(/^sha256:/.test(s.observationWindowId), "#1 창 식별자");
  const doc = run(r, "doctor").stdout;
  assert.match(doc, /수신 행동\s*:\s*0건/, "#1 현재 창 관찰 0");
  assert.match(doc, /창 밖 잔재\s*:\s*2건/, "#1 stale 2");
  assert.match(doc, /창 생성 명령:\s*start/, "#1 doctor 출처=start");
}

// ── 성공조건 2: 옛 capture 2건 + begin → 옛 기록 보존, 현재 창 관찰 0, stale 2, createdByCommand=begin ──
// 🔴 이것이 진범 봉쇄의 핵심: begin 이 과거 capture 를 지우지 않는다(옛 reset 제거 확인).
{
  const r = repo();
  seedOldCapture(r);
  const res = run(r, "begin", ["--contract", join(r, ".agent-guard", "contract.yaml")]);
  assert.equal(res.status, 0, "#2 begin 성공");
  assert.equal(captureLines(r), 2, "🔴 #2 begin 은 과거 capture 를 삭제하지 않는다(비파괴 관찰 창)");
  const s = loadSession(r);
  assert.equal(s.createdByCommand, "begin", "#2 createdByCommand=begin");
  assert.equal(s.captureBoundary.seq, 2, "#2 경계 seq=2");
  const doc = run(r, "doctor").stdout;
  assert.match(doc, /수신 행동\s*:\s*0건/, "#2 현재 창 관찰 0");
  assert.match(doc, /창 밖 잔재\s*:\s*2건/, "#2 stale 2");
  assert.match(doc, /창 생성 명령:\s*begin/, "#2 doctor 출처=begin");
}

// ── 성공조건 3: begin 이후 새 행동 1건 → OBSERVED, current 1, stale 2 ──
{
  const r = repo();
  wireHook(r); // OBSERVED = 훅 배선 전제(기록이 존재하려면 훅이 있어야 한다)
  seedOldCapture(r);
  run(r, "begin", ["--contract", join(r, ".agent-guard", "contract.yaml")]);
  appendNewAction(r); // seq 3 (경계 초과)
  const doc = run(r, "doctor").stdout;
  assert.match(doc, /수신 행동\s*:\s*1건/, "#3 새 행동(seq>경계)은 이번 세션 관찰");
  assert.match(doc, /창 밖 잔재\s*:\s*2건/, "#3 옛 기록은 여전히 stale");
  assert.match(doc, /관찰 상태\s*:\s*OBSERVED/, "#3 OBSERVED");
}

// ── 성공조건 4: start 이후 새 행동 1건 → OBSERVED, current 1, stale 2 ──
{
  const r = repo();
  wireHook(r);
  seedOldCapture(r);
  run(r, "start", ["--contract", join(r, ".agent-guard", "contract.yaml")]);
  appendNewAction(r);
  const doc = run(r, "doctor").stdout;
  assert.match(doc, /수신 행동\s*:\s*1건/, "#4 start 도 대칭: 새 행동은 관찰");
  assert.match(doc, /창 밖 잔재\s*:\s*2건/, "#4 stale 2");
  assert.match(doc, /관찰 상태\s*:\s*OBSERVED/, "#4 OBSERVED");
}

// ── 성공조건 5: legacy session.json(출처 필드 없음) → 로딩 성공, 판정 유지, doctor 는 legacy-unknown ──
{
  const r = repo();
  const legacy = { version: 1, baselineHead: "deadbeef", createdAt: "2026-07-01T00:00:00.000Z", contractId: "t", gitBranch: "main", unstagedAtStart: [], stagedAtStart: [], untrackedAtStart: [] };
  writeFileSync(join(r, ".agent-guard", "session.json"), JSON.stringify(legacy, null, 2) + "\n");
  const doc = run(r, "doctor").stdout;
  assert.equal(run(r, "doctor").status, 0, "#5 legacy 세션도 크래시 없이 로딩");
  assert.match(doc, /창 생성 명령:\s*legacy-unknown/, "#5 출처 필드 없으면 legacy-unknown(추측 금지)");
}

console.log("session-provenance.test.ts OK");
