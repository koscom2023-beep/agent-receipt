// agent-guard A0.5 — golden baseline 캡처기 (read-only against src; subprocess only).
//
// 목적: v0.1 현재 상태의 stdout / stderr / exit code / 사용 contract 기준선을 test/golden/ 에 봉인.
//        기능 구현·출력 변경 0. src/cli/schema/checks/git/output·package·tsconfig·README·CONTRACT 무수정.
//
// 실행: node_modules/.bin/tsx test/capture-golden.ts
//
// 설계(run-fixtures.ts 패턴 계승):
//  - 각 케이스는 OS tmpdir 에 격리된 git repo 를 새로 만든다(전역상태 오염 0).
//  - 실제 CLI 를 서브프로세스로 띄워 stdout/stderr/exit 를 그대로 캡처(in-process chdir 배제).
//  - tsx 는 node_modules/.bin 절대경로로만 호출. src 에서 import 하지 않는다(결합 0).
//  - 계약 YAML 은 repo *밖*(case base) 에 둬서 repo git 상태를 오염시키지 않는다.
//  - 결정론: 고정 git identity + 고정 author/committer DATE → headHash 재현 가능.
//  - 정규화는 *캡처 스냅샷* 한정($HOME→<HOME>, tmp fixture 경로→<FIXTURE>). CLI 출력은 불변.

import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");
const goldenDir = join(here, "golden");

if (!existsSync(tsxBin)) {
  console.error(`ENV ERROR: tsx 없음 (${tsxBin}). 먼저 'npm install'.`);
  process.exit(1);
}
mkdirSync(goldenDir, { recursive: true });

const HOME = process.env["HOME"] ?? "";
const TMP = tmpdir();
const FIXED_DATE = "2025-01-01T00:00:00 +0000";

// 호스트 git config·GIT_* 차단 + 고정 DATE 로 결정론화.
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
};

function git(cwd: string, args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: ENV, stdio: ["ignore", "ignore", "ignore"] }
  );
}

function newCase(): { base: string; repo: string; contract: string } {
  const base = mkdtempSync(join(tmpdir(), "ag-gold-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "f.txt"), "base content\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return { base, repo, contract: join(base, "contract.yaml") };
}

function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function norm(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(new RegExp(escapeRe(TMP) + "/ag-gold-[^\\s\"']*", "g"), "<FIXTURE>");
  if (HOME) out = out.split(HOME).join("<HOME>");
  return out;
}

type RunRes = { status: number | null; stdout: string; stderr: string };
function run(cwd: string, command: string, args: string[]): RunRes {
  const res = spawnSync(tsxBin, [cli, command, ...args], { cwd, env: ENV, encoding: "utf8" });
  if (res.error) throw new Error(`서브프로세스 spawn 실패(${command}): ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const captures: Array<{ name: string; cmdline: string; exit: number | null }> = [];

function emit(
  name: string,
  cmdline: string,
  res: RunRes,
  contractText: string | null,
  fixtureBase?: string,
): void {
  // fixtureBase 가 주어지면 그 절대경로만 <FIXTURE> 로 치환(접미사 보존). 없으면 기존 동작 그대로.
  const pre = (s: string): string => (fixtureBase ? s.split(fixtureBase).join("<FIXTURE>") : s);
  const dir = join(goldenDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmd.txt"), cmdline + "\n");
  writeFileSync(join(dir, "exit_code.txt"), `${res.status}\n`);
  writeFileSync(join(dir, "stdout.txt"), norm(pre(res.stdout ?? "")));
  const e = norm(pre(res.stderr ?? ""));
  const stderrPath = join(dir, "stderr.txt");
  if (e.length) writeFileSync(stderrPath, e);
  else rmSync(stderrPath, { force: true }); // 재캡처 시 이전 실행의 stderr 잔재 제거
  if (contractText != null) writeFileSync(join(dir, "contract.yaml"), contractText);
  captures.push({ name, cmdline, exit: res.status });
}

const bases: string[] = [];
function track<T extends { base: string }>(c: T): T {
  bases.push(c.base);
  return c;
}

// ───────────────────────────── 케이스 ─────────────────────────────

// 1) verify PASS (human): 허용 범위 안 변경.
{
  const c = track(newCase());
  const contract = `id: gold-verify-pass\nscope:\n  allowed_paths:\n    - "f.txt"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "f.txt"), "edited within allowed scope\n");
  const r = run(c.repo, "verify", ["--contract", c.contract]);
  emit("case-01-verify-pass", "guard verify --contract contract.yaml", r, contract);
}

// 2) verify FAIL (human): 금지 경로 변경.
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "secret.txt"), "secret base\n");
  git(c.repo, ["add", "secret.txt"]);
  git(c.repo, ["commit", "-q", "-m", "add secret"]);
  const contract =
    `id: gold-verify-denied\ntitle: denied path test\nbranch:\n  expected: main\n` +
    `scope:\n  allowed_paths:\n    - "**"\n  denied_paths:\n    - "secret.txt"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "secret.txt"), "secret MODIFIED\n");
  const r = run(c.repo, "verify", ["--contract", c.contract]);
  emit("case-02-verify-denied-fail", "guard verify --contract contract.yaml", r, contract);
}

// 3) verify FAIL (human): untracked 존재 (require_no_staged_untracked).
{
  const c = track(newCase());
  const contract =
    `id: gold-verify-untracked\nscope:\n  allowed_paths:\n    - "**"\n` +
    `git:\n  require_no_staged_untracked: true\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "u.txt"), "untracked file\n");
  const r = run(c.repo, "verify", ["--contract", c.contract]);
  emit("case-03-verify-untracked-fail", "guard verify --contract contract.yaml", r, contract);
}

// 4a) verify --json 대표 PASS.
{
  const c = track(newCase());
  const contract = `id: gold-verify-json-pass\nscope:\n  allowed_paths:\n    - "f.txt"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "f.txt"), "edited within allowed scope\n");
  const r = run(c.repo, "verify", ["--json", "--contract", c.contract]);
  emit("case-04a-verify-json-pass", "guard verify --json --contract contract.yaml", r, contract);
}

// 4b) verify --json 대표 FAIL (denied).
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "secret.txt"), "secret base\n");
  git(c.repo, ["add", "secret.txt"]);
  git(c.repo, ["commit", "-q", "-m", "add secret"]);
  const contract =
    `id: gold-verify-json-denied\ntitle: denied path test\nbranch:\n  expected: main\n` +
    `scope:\n  allowed_paths:\n    - "**"\n  denied_paths:\n    - "secret.txt"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "secret.txt"), "secret MODIFIED\n");
  const r = run(c.repo, "verify", ["--json", "--contract", c.contract]);
  emit("case-04b-verify-json-denied-fail", "guard verify --json --contract contract.yaml", r, contract);
}

// 5) check PASS: required_checks.commands 통과 (git 불필요).
{
  const c = track(newCase());
  const contract =
    `id: gold-check-pass\nscope:\n  allowed_paths: []\n` +
    `required_checks:\n  commands:\n` +
    `    - name: echo-ok\n      command: 'echo "check ok"'\n      required_exit: 0\n`;
  writeFileSync(c.contract, contract);
  const r = run(c.repo, "check", ["--contract", c.contract]);
  emit("case-05-check-pass", "guard check --contract contract.yaml", r, contract);
}

// 6) check FAIL: 명령이 required_exit 와 불일치.
{
  const c = track(newCase());
  const contract =
    `id: gold-check-fail\nscope:\n  allowed_paths: []\n` +
    `required_checks:\n  commands:\n` +
    `    - name: echo-fail\n      command: 'echo "check failed"; exit 1'\n      required_exit: 0\n`;
  writeFileSync(c.contract, contract);
  const r = run(c.repo, "check", ["--contract", c.contract]);
  emit("case-06-check-fail", "guard check --contract contract.yaml", r, contract);
}

// 7) prompt 출력 (git 불필요 — 지시문 생성).
{
  const c = track(newCase());
  const contract =
    `id: gold-prompt\ntitle: prompt block test\nbranch:\n  expected: main\n` +
    `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - "package.json"\n` +
    `forbidden_actions:\n  - push\n  - deploy\n` +
    `required_checks:\n  commands:\n    - name: tsc\n      command: 'tsc --noEmit'\n      required_exit: 0\n` +
    `report:\n  required_items:\n    - 변경 요약\n`;
  writeFileSync(c.contract, contract);
  const r = run(c.repo, "prompt", ["--contract", c.contract]);
  emit("case-07-prompt", "guard prompt --contract contract.yaml", r, contract);
}

// 8) report 출력: verify + 마크다운 저장 (--out 으로 golden md 직접 생성).
{
  const c = track(newCase());
  const contract =
    `id: gold-report\ntitle: golden report\nbranch:\n  expected: main\n` +
    `scope:\n  allowed_paths:\n    - "f.txt"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "f.txt"), "edited for report\n");
  const dir = join(goldenDir, "case-08-report");
  mkdirSync(dir, { recursive: true });
  const outMd = join(dir, "report.generated.md");
  const r = run(c.repo, "report", ["--contract", c.contract, "--out", outMd]);
  emit("case-08-report", "guard report --contract contract.yaml --out report.generated.md", r, contract);
  // 생성된 마크다운도 golden 산출물 — 휘발 경로만 정규화(내용/문구 불변).
  if (existsSync(outMd)) writeFileSync(outMd, norm(readFileSync(outMd, "utf8")));
}

// 9a) pre PASS: clean + 브랜치 일치.
{
  const c = track(newCase());
  const contract =
    `id: gold-pre-pass\nbranch:\n  expected: main\nscope:\n  allowed_paths:\n    - "**"\n`;
  writeFileSync(c.contract, contract);
  const r = run(c.repo, "pre", ["--contract", c.contract]);
  emit("case-09a-pre-pass", "guard pre --contract contract.yaml", r, contract);
}

// 9b) pre FAIL: 브랜치 불일치 + 이미 stage 된 파일.
{
  const c = track(newCase());
  const contract =
    `id: gold-pre-fail\nbranch:\n  expected: dev\nscope:\n  allowed_paths:\n    - "**"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "g.txt"), "staged before start\n");
  git(c.repo, ["add", "g.txt"]);
  const r = run(c.repo, "pre", ["--contract", c.contract]);
  emit("case-09b-pre-fail", "guard pre --contract contract.yaml", r, contract);
}

// ───────────────────────────── A6 신규 케이스: A3 자동탐색 + A4 init ─────────────────────────────
// 기존 11케이스(위)는 그대로. 아래는 A3/A4 신규 동작만 추가 캡처한다(기존 출력 동결 + 증거 확장).

// 자동탐색: 기본 위치에 계약을 두고 --contract 없이 verify. layout = [[상대경로, 내용], ...].
function discoverProbe(name: string, cmdline: string, layout: Array<[string, string]>): void {
  const c = track(newCase());
  writeFileSync(join(c.repo, "f.txt"), "edited under discovered contract\n");
  for (const [rel, body] of layout) {
    const p = join(c.repo, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const r = run(c.repo, "verify", []); // --contract 없음 → discoverContract()
  emit(name, cmdline, r, null, c.base);
}

const Y = (id: string): string => `id: ${id}\nscope: {}\n`;
const J = (id: string): string => `{"id":"${id}","scope":{}}\n`;

discoverProbe(
  "new-01-discover-agdir-yaml",
  "guard verify   (auto-discover .agent-guard/contract.yaml)",
  [[".agent-guard/contract.yaml", Y("discover-agdir-yaml")]],
);
discoverProbe(
  "new-02-discover-agdir-json",
  "guard verify   (auto-discover .agent-guard/contract.json)",
  [[".agent-guard/contract.json", J("discover-agdir-json")]],
);
discoverProbe(
  "new-03-discover-priority",
  "guard verify   (priority: .agent-guard/contract.yaml > .json > agent-guard.yaml > agent-guard.json)",
  [
    [".agent-guard/contract.yaml", Y("discover-prio-1-agdir-yaml")],
    [".agent-guard/contract.json", J("discover-prio-2-agdir-json")],
    ["agent-guard.yaml", Y("discover-prio-3-root-yaml")],
    ["agent-guard.json", J("discover-prio-4-root-json")],
  ],
);

// init: 비-repo 임시 디렉터리에서 실행(init 은 git repo 불필요). 생성물도 함께 보관.
function initBase(): string {
  const base = mkdtempSync(join(tmpdir(), "ag-gold-"));
  bases.push(base);
  return base;
}
function saveCreated(name: string, base: string): void {
  const dir = join(goldenDir, name);
  const cy = join(base, ".agent-guard", "contract.yaml");
  const rm = join(base, ".agent-guard", "README.md");
  if (existsSync(cy)) writeFileSync(join(dir, "created-contract.yaml"), readFileSync(cy, "utf8"));
  if (existsSync(rm)) writeFileSync(join(dir, "created-README.md"), readFileSync(rm, "utf8"));
}

{
  const base = initBase();
  const r = run(base, "init", ["--preset", "generic"]);
  emit("new-04-init-generic", "guard init --preset generic", r, null, base);
  saveCreated("new-04-init-generic", base);
}
{
  const base = initBase();
  const r = run(base, "init", ["--preset", "nextjs-supabase"]);
  emit("new-05-init-nextjs-supabase", "guard init --preset nextjs-supabase", r, null, base);
  saveCreated("new-05-init-nextjs-supabase", base);
}
{
  const base = initBase();
  run(base, "init", ["--preset", "generic"]); // 1차 생성(출력 버림)
  const r = run(base, "init", ["--preset", "generic"]); // 2차 → 덮어쓰기 거부
  emit("new-06-init-overwrite-fail", "guard init --preset generic   (재실행: 덮어쓰기 거부)", r, null, base);
}
{
  const base = initBase();
  const r = run(base, "init", ["--preset", "bogus"]);
  emit("new-07-init-unknown-preset", "guard init --preset bogus", r, null, base);
}
{
  const base = initBase();
  const r = run(base, "init", []);
  emit("new-08-init-no-preset", "guard init", r, null, base);
}

// ───────────────────────────── P2: 비ASCII/공백 경로 (NUL 파싱) ─────────────────────────────
// git path 를 -z 로 읽어 한글·공백 경로가 quoting/octal 없이 raw UTF-8 로 잡히는지 + denied glob 정확 매칭 고정.

// p2-01: unstaged(한글) + staged(한글) + untracked(한글/공백) 모두 정상 UTF-8 수집 (allowed:[] → PASS)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "추적.txt"), "tracked korean\n");
  git(c.repo, ["add", "추적.txt"]);
  git(c.repo, ["commit", "-q", "-m", "add korean tracked"]);
  writeFileSync(join(c.repo, "추적.txt"), "tracked korean edited\n"); // unstaged 수정
  writeFileSync(join(c.repo, "스테이지.txt"), "staged korean\n");
  git(c.repo, ["add", "스테이지.txt"]); // staged
  writeFileSync(join(c.repo, "미추적.txt"), "untracked korean\n"); // untracked
  writeFileSync(join(c.repo, "my file.txt"), "space name\n"); // untracked + 공백
  const contract = `id: p2-utf8-paths\nscope:\n  allowed_paths: []\n`;
  writeFileSync(c.contract, contract);
  emit("p2-01-utf8-paths-json", "guard verify --json --contract contract.yaml",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
  emit("p2-01b-utf8-paths-human", "guard verify --contract contract.yaml",
    run(c.repo, "verify", ["--contract", c.contract]), contract);
}

// p2-02: denied_paths 의 한글 glob 이 한글 경로를 정확히 잡는지 (P2 이전엔 거짓 PASS → 회귀 가드)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "비밀"), { recursive: true });
  writeFileSync(join(c.repo, "비밀", "문서.txt"), "secret korean\n");
  const contract =
    `id: p2-denied-utf8\ntitle: denied 한글 경로 매칭\n` +
    `scope:\n  allowed_paths: []\n  denied_paths:\n    - "비밀/**"\n`;
  writeFileSync(c.contract, contract);
  emit("p2-02-denied-utf8-json", "guard verify --json --contract contract.yaml",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// ───────────────────────────── P1-A: start / session 작성 ─────────────────────────────
// `agent-guard start` 가 baseline snapshot 을 .agent-guard/session.json 에 쓰는지 + 안전조건(denied dirty / 기존 존재) 고정.
// verify 의 baseline 적용은 아직 없음(P1-B). createdAt 만 비결정적이라 <TS> 로 정규화.

function saveSession(name: string, repo: string): void {
  const sp = join(repo, ".agent-guard", "session.json");
  if (!existsSync(sp)) return;
  // createdAt 타임스탬프만 정규화(baselineHead 등 나머지는 고정 git date 로 결정론).
  const normed = readFileSync(sp, "utf8").replace(/"createdAt": "[^"]*"/, '"createdAt": "<TS>"');
  writeFileSync(join(goldenDir, name, "created-session.json"), normed);
}

// p1a-01: start 성공 — non-denied ambient untracked 스냅샷, session.json 생성, exit 0
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient-doc.txt"), "ambient untracked\n");
  const contract = `id: p1a-start\nscope:\n  allowed_paths: []\n  denied_paths:\n    - ".env*"\n`;
  writeFileSync(c.contract, contract);
  emit("p1a-01-start-success", "guard start --contract contract.yaml",
    run(c.repo, "start", ["--contract", c.contract]), contract);
  saveSession("p1a-01-start-success", c.repo);
}

// p1a-02: start 실패 — denied(.env*) dirty → exit 1, session 미작성
{
  const c = track(newCase());
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n");
  const contract = `id: p1a-start-denied\nscope:\n  allowed_paths: []\n  denied_paths:\n    - ".env*"\n`;
  writeFileSync(c.contract, contract);
  emit("p1a-02-start-denied-fail", "guard start --contract contract.yaml",
    run(c.repo, "start", ["--contract", c.contract]), contract);
  // 안전 단언: denied dirty 면 session 이 절대 생기면 안 된다(거짓이면 BUG → golden 으로 고정).
  writeFileSync(join(goldenDir, "p1a-02-start-denied-fail", "session-written.txt"),
    existsSync(join(c.repo, ".agent-guard", "session.json")) ? "WRITTEN(BUG)\n" : "not-written\n");
}

// p1a-03: start 실패 — 이미 session 존재 → 덮어쓰기 거부, exit 1
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient-doc.txt"), "ambient untracked\n");
  const contract = `id: p1a-start-exists\nscope:\n  allowed_paths: []\n  denied_paths:\n    - ".env*"\n`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]); // 1차 성공(출력 버림)
  emit("p1a-03-start-exists-fail", "guard start --contract contract.yaml   (재실행: 덮어쓰기 거부)",
    run(c.repo, "start", ["--contract", c.contract]), contract);
}

// p1a-04: start — 계약 없음 → exit 2 (기존 계약 해석 경로와 일관)
{
  const c = track(newCase());
  emit("p1a-04-start-no-contract", "guard start   (no --contract, none discoverable)",
    run(c.repo, "start", []), null);
}

// ───────────────────────────── P1-B: verify baseline 적용 ─────────────────────────────
// 유효 session 있으면 baseline 이후 신규 변경만 scope 검사. denied 는 full touched. session.json 제외. stale → degrade.

const P1B_DENIED = `  denied_paths:\n    - ".env*"\n`;

// p1b-01: session 없음 + ambient untracked + allowed src/** → ambient 가 outOfScope 로 FAIL (v0.1 동작)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-no-session\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  emit("p1b-01-no-session-ambient-fail", "guard verify --json --contract contract.yaml   (no start)",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-02: start → ambient 는 baseline 으로 제외 → verify PASS
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-session-pass\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]); // baseline: untrackedAtStart=[ambient.txt]
  emit("p1b-02-session-ambient-pass", "guard start … ; guard verify --json --contract contract.yaml",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-03: start 이후 신규 범위 밖 파일 → outOfScope FAIL (ambient 는 계속 무시)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-new-oos\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]);
  writeFileSync(join(c.repo, "newfile.txt"), "new out-of-scope\n"); // start 이후 신규
  emit("p1b-03-session-new-oos-fail", "guard start … ; (new file) ; guard verify --json",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-04: start 이후 신규 denied 파일 → deniedHits FAIL (allowed:[] 로 denied 만 격리)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-new-denied\nscope:\n  allowed_paths: []\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]);
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n"); // start 이후 신규 denied
  emit("p1b-04-session-new-denied-fail", "guard start … ; (new .env.local) ; guard verify --json",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-05: .agent-guard/session.json 자체는 verify 에 안 잡힘 (allowed src/** 인데도 PASS)
{
  const c = track(newCase());
  const contract = `id: p1b-session-excluded\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]); // session.json = 유일 untracked
  emit("p1b-05-session-json-excluded", "guard start … ; guard verify --json   (session.json 제외)",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-06: stale session(branch 변경) → baseline 무시 + full-tree degrade (ambient 재등장 → FAIL)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-stale-branch\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]); // session.gitBranch = main
  git(c.repo, ["checkout", "-q", "-b", "other"]); // branch 변경 → stale
  emit("p1b-06-stale-branch-degrade", "guard start (main) … checkout other ; guard verify --json",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-07: 유효 session + verify --json → stable 14키 유지 (clean fixture)
{
  const c = track(newCase());
  const contract = `id: p1b-json-keys\nscope:\n  allowed_paths: []\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]);
  emit("p1b-07-session-json-14keys", "guard start … ; guard verify --json   (14키 유지)",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), contract);
}

// p1b-08: stale session + verify(human) → full-tree degrade + stale 경고 출력 (output.ts UX)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  const contract = `id: p1b-stale-human\nscope:\n  allowed_paths:\n    - "src/**"\n${P1B_DENIED}`;
  writeFileSync(c.contract, contract);
  run(c.repo, "start", ["--contract", c.contract]); // session.gitBranch = main
  git(c.repo, ["checkout", "-q", "-b", "other"]); // stale (branch 변경)
  emit("p1b-08-stale-human-degrade", "guard start (main) … checkout other ; guard verify --contract contract.yaml",
    run(c.repo, "verify", ["--contract", c.contract]), contract); // human 모드 → 경고
}

// ───────────────────────────── v0.3: status / reset ─────────────────────────────
const V03_CONTRACT =
  `id: v03\ntitle: v0.3 usability\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\n`;

// v03-01: status — session 없음
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  writeFileSync(c.contract, V03_CONTRACT);
  emit("v03-01-status-no-session", "guard status --contract contract.yaml",
    run(c.repo, "status", ["--contract", c.contract]), V03_CONTRACT);
}
// v03-02: status — session 활성
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  writeFileSync(c.contract, V03_CONTRACT);
  run(c.repo, "start", ["--contract", c.contract]);
  emit("v03-02-status-with-session", "guard start … ; guard status --contract contract.yaml",
    run(c.repo, "status", ["--contract", c.contract]), V03_CONTRACT);
}
// v03-03: status — session stale(branch 변경 → 무효 표시)
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  writeFileSync(c.contract, V03_CONTRACT);
  run(c.repo, "start", ["--contract", c.contract]);
  git(c.repo, ["checkout", "-q", "-b", "other"]);
  emit("v03-03-status-stale", "guard start (main) … checkout other ; guard status",
    run(c.repo, "status", ["--contract", c.contract]), V03_CONTRACT);
}
// v03-04: reset — session 있음 → 제거
{
  const c = track(newCase());
  writeFileSync(c.contract, V03_CONTRACT);
  run(c.repo, "start", ["--contract", c.contract]);
  emit("v03-04-reset-with-session", "guard start … ; guard reset",
    run(c.repo, "reset", []), null);
}
// v03-05: reset — session 없음
{
  const c = track(newCase());
  emit("v03-05-reset-no-session", "guard reset   (no session)",
    run(c.repo, "reset", []), null);
}

// ───────────────────────────── v1-core: receipt / doctor / lint ─────────────────────────────
const V1_CONTRACT =
  `id: v1\ntitle: v1-core\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;

function saveReceipt(name: string, repo: string, fname: string): void {
  const sp = join(repo, fname);
  if (!existsSync(sp)) return;
  let s = readFileSync(sp, "utf8");
  s = s.replace(/"timestamp": "[^"]*"/, '"timestamp": "<TS>"'); // json
  s = s.replace(/- timestamp: .*/, "- timestamp: <TS>"); // md
  writeFileSync(join(goldenDir, name, `created-${fname}`), s);
}

// v1-01: receipt json — session 활성 → ok=true
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  writeFileSync(c.contract, V1_CONTRACT);
  run(c.repo, "start", ["--contract", c.contract]);
  emit("v1-01-receipt-json", "guard start … ; guard receipt --format json --out receipt.json",
    run(c.repo, "receipt", ["--format", "json", "--out", "receipt.json", "--contract", c.contract]), V1_CONTRACT);
  saveReceipt("v1-01-receipt-json", c.repo, "receipt.json");
}
// v1-02: receipt md
{
  const c = track(newCase());
  writeFileSync(join(c.repo, "ambient.txt"), "ambient\n");
  writeFileSync(c.contract, V1_CONTRACT);
  run(c.repo, "start", ["--contract", c.contract]);
  emit("v1-02-receipt-md", "guard start … ; guard receipt --format md --out receipt.md",
    run(c.repo, "receipt", ["--format", "md", "--out", "receipt.md", "--contract", c.contract]), V1_CONTRACT);
  saveReceipt("v1-02-receipt-md", c.repo, "receipt.md");
}
// v1-03: receipt fail — 신규 oos(no start) → ok=false, exit 1
{
  const c = track(newCase());
  writeFileSync(c.contract, V1_CONTRACT);
  writeFileSync(join(c.repo, "outsider.md"), "out\n");
  emit("v1-03-receipt-fail", "guard receipt --format json --out receipt.json   (no start, oos)",
    run(c.repo, "receipt", ["--format", "json", "--out", "receipt.json", "--contract", c.contract]), V1_CONTRACT);
  saveReceipt("v1-03-receipt-fail", c.repo, "receipt.json");
}
// v1-04: doctor — git + 계약 발견 + baseline 없음
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V1_CONTRACT);
  emit("v1-04-doctor-ok", "guard doctor", run(c.repo, "doctor", []), null);
}
// v1-05: doctor — 계약 없음(경고)
{
  const c = track(newCase());
  emit("v1-05-doctor-no-contract", "guard doctor   (no contract)", run(c.repo, "doctor", []), null);
}
// v1-06: lint — 경고 다수(allowed:[], denied '**', forbidden_actions, commands:[])
{
  const c = track(newCase());
  const contract =
    `id: v1-lint\nscope:\n  allowed_paths: []\n  denied_paths:\n    - "**"\n` +
    `forbidden_actions:\n  - push\nrequired_checks:\n  commands: []\n`;
  writeFileSync(c.contract, contract);
  emit("v1-06-lint-warn", "guard lint --contract contract.yaml",
    run(c.repo, "lint", ["--contract", c.contract]), contract);
}

// ───────────────────────────── V1-Core Sprint 2 (v0.4): claims / explain / router / check-127 ─────────────────────────────
// 새 명령(claims/explain) + 단일명령 라우팅(bare) + check exit127 구분. 기존 케이스는 위에서 동결.
const S2_ALL =
  `id: s2-all\ntitle: sprint2\nscope:\n  allowed_paths:\n    - "**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;
const S2_SRC =
  `id: s2-src\ntitle: sprint2 src-only\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;

// 인자 없이(=명령 없이) CLI 실행 → 단일명령 라우팅(runDefault). run() 은 항상 command 를 넣으므로 별도 헬퍼.
function runBare(cwd: string, args: string[]): RunRes {
  const res = spawnSync(tsxBin, [cli, ...args], { cwd, env: ENV, encoding: "utf8" });
  if (res.error) throw new Error(`서브프로세스 spawn 실패(bare): ${res.error.message}`);
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// v04-01: claims 일치 → exit 0 (allowed:**, f.txt 수정, claim 이 정확). claim 파일은 repo 밖(base)에 둔다.
{
  const c = track(newCase());
  writeFileSync(c.contract, S2_ALL);
  writeFileSync(join(c.repo, "f.txt"), "edited within scope\n");
  const claim = join(c.base, "claim.json");
  writeFileSync(claim, JSON.stringify({ changedFiles: ["f.txt"], newFiles: [], deniedHits: [], tests: true, summary: "edit f.txt" }, null, 2) + "\n");
  emit("v04-01-claims-match", "guard claims --file claim.json --contract contract.yaml",
    run(c.repo, "claims", ["--file", claim, "--contract", c.contract]), S2_ALL, c.base);
}
// v04-02: claims mismatch → exit 1 (AI 가 newfile.txt 를 숨김)
{
  const c = track(newCase());
  writeFileSync(c.contract, S2_ALL);
  writeFileSync(join(c.repo, "f.txt"), "edited within scope\n");
  writeFileSync(join(c.repo, "newfile.txt"), "hidden new file\n");
  const claim = join(c.base, "claim.json");
  writeFileSync(claim, JSON.stringify({ changedFiles: ["f.txt"], newFiles: [], deniedHits: [], tests: true, summary: "only edited f.txt" }, null, 2) + "\n");
  emit("v04-02-claims-mismatch", "guard claims --file claim.json   (AI hid newfile.txt)",
    run(c.repo, "claims", ["--file", claim, "--contract", c.contract]), S2_ALL, c.base);
}
// v04-03: claims 파일 없음 → exit 2
{
  const c = track(newCase());
  writeFileSync(c.contract, S2_ALL);
  emit("v04-03-claims-no-file", "guard claims --file nope.json --contract contract.yaml   (missing)",
    run(c.repo, "claims", ["--file", "nope.json", "--contract", c.contract]), S2_ALL);
}
// v04-04: explain PASS (allowed f.txt, 범위 안 수정)
{
  const c = track(newCase());
  const contract = `id: s2-explain-pass\nscope:\n  allowed_paths:\n    - "f.txt"\n  denied_paths:\n    - ".env*"\n`;
  writeFileSync(c.contract, contract);
  writeFileSync(join(c.repo, "f.txt"), "edited within scope\n");
  emit("v04-04-explain-pass", "guard explain --contract contract.yaml",
    run(c.repo, "explain", ["--contract", c.contract]), contract);
}
// v04-05: explain FAIL (allowed src/**, 범위 밖 새 파일)
{
  const c = track(newCase());
  writeFileSync(c.contract, S2_SRC);
  writeFileSync(join(c.repo, "newfile.txt"), "out of scope\n");
  emit("v04-05-explain-fail", "guard explain --contract contract.yaml   (oos)",
    run(c.repo, "explain", ["--contract", c.contract]), S2_SRC);
}
// v04-06: router — 계약 없음 → init 안내 (bare)
{
  const c = track(newCase());
  emit("v04-06-router-no-contract", "guard   (no command, no contract)",
    runBare(c.repo, []), null);
}
// v04-07: router — 계약 있음(.agent-guard/), session 없음 → start 안내 (bare)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S2_SRC);
  emit("v04-07-router-no-session", "guard   (no command; contract, no session)",
    runBare(c.repo, []), null, c.base);
}
// v04-08: router — session 있음 → verify 실행 (bare, PASS). contract.yaml 은 start 전 생성 → baseline 에 묻힘.
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S2_SRC);
  run(c.repo, "start", []); // .agent-guard/contract.yaml 자동탐색 → session 기록
  emit("v04-08-router-verify", "guard start … ; guard   (no command → verify)",
    runBare(c.repo, []), null, c.base);
}
// v04-09: check — exit 127 → 코드 실패가 아니라 환경 문제로 구분 표시 ('exit 127' 은 stderr 없이 결정론적)
{
  const c = track(newCase());
  const contract =
    `id: s2-check-127\nscope:\n  allowed_paths: []\n` +
    `required_checks:\n  commands:\n    - name: missing-cmd\n      command: 'exit 127'\n      required_exit: 0\n`;
  writeFileSync(c.contract, contract);
  emit("v04-09-check-127", "guard check --contract contract.yaml   (exit 127 = env problem)",
    run(c.repo, "check", ["--contract", c.contract]), contract);
}

// ───────────────────────────── V1 Integrated Sprint 3 (v0.5): promptia preset / run alias / promptia-aware lint·doctor / router FAIL ─────────────────────────────
// 새 preset(promptia) + `run` 별칭 + promptia 감지 lint·doctor 경고 + router FAIL 안내. 기존 케이스는 위에서 동결.
const PROMPTIA_FULL_DENIED =
  `id: promptia\ntitle: Promptia patch-only guard\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n` +
  `    - ".env*"\n    - "package-lock.json"\n    - "pnpm-lock.yaml"\n    - "supabase/migrations/**"\n` +
  `    - "vercel.json"\n    - ".vercel/**"\n    - "exports/**"\n    - "docs/arch/json/**"\n` +
  `required_checks:\n  commands: []\n`;
const PROMPTIA_MISSING_DENIED =
  `id: promptia\ntitle: Promptia (denied 누락)\nscope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\n` +
  `required_checks:\n  commands:\n    - name: t\n      command: 'echo ok'\n      required_exit: 0\n`;

// v05-01: init --preset promptia → 생성물(promptia 계약) 캡처
{
  const base = initBase();
  const r = run(base, "init", ["--preset", "promptia"]);
  emit("v05-01-init-promptia", "guard init --preset promptia", r, null, base);
  saveCreated("v05-01-init-promptia", base);
}
// v05-02: lint — promptia preset, 핵심 denied_paths 누락 → [promptia] 경고 다수
{
  const c = track(newCase());
  writeFileSync(c.contract, PROMPTIA_MISSING_DENIED);
  emit("v05-02-lint-promptia-missing", "guard lint --contract contract.yaml   (promptia, denied 누락)",
    run(c.repo, "lint", ["--contract", c.contract]), PROMPTIA_MISSING_DENIED);
}
// v05-03: lint — promptia preset, denied_paths 완비 → [promptia] 경고 0 (vacuous commands 경고만)
{
  const c = track(newCase());
  writeFileSync(c.contract, PROMPTIA_FULL_DENIED);
  emit("v05-03-lint-promptia-complete", "guard lint --contract contract.yaml   (promptia, denied 완비)",
    run(c.repo, "lint", ["--contract", c.contract]), PROMPTIA_FULL_DENIED);
}
// v05-04: doctor — promptia preset 감지 라인
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), PROMPTIA_FULL_DENIED);
  emit("v05-04-doctor-promptia", "guard doctor   (promptia preset 감지)", run(c.repo, "doctor", []), null);
}
// v05-05: router(bare) — session 있음 + start 이후 신규 oos → verify FAIL → 진단/복구 안내(explain/status/reset)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S2_SRC);
  run(c.repo, "start", []); // baseline (contract.yaml 은 ambient 로 묻힘)
  writeFileSync(join(c.repo, "newfile.txt"), "new out-of-scope\n"); // start 이후 신규 oos
  emit("v05-05-router-fail", "guard start … ; (new oos) ; guard   (no command → verify FAIL)",
    runBare(c.repo, []), null, c.base);
}
// v05-06: run 별칭 — 계약 없음 → init 안내(promptia/generic). `run` 명령이 bare 와 동일 경로임을 고정.
{
  const c = track(newCase());
  emit("v05-06-run-alias-no-contract", "guard run   (no contract → init 안내, run 별칭)",
    run(c.repo, "run", []), null);
}

// ───────────────────────────── V1 Integrated Sprint 4 (v0.6): mode / receipts ─────────────────────────────
// 새 명령 mode(task/daily 설명) + receipts(저장 receipt 조회). 기존 케이스는 위에서 동결.
const V06_SRC =
  `id: v06\ntitle: v0.6 mode/receipts\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;
// receipt 내용의 wall-clock ISO timestamp 만 <TS> 로 정규화(headHash/contentHash 는 고정 git date 로 결정론적).
const normTs = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>");

// v06-01: mode — 계약 없음(모드 이전 → init 안내)
{
  const c = track(newCase());
  emit("v06-01-mode-no-contract", "guard mode   (no contract)", run(c.repo, "mode", []), null);
}
// v06-02: mode — 계약 + baseline 활성(task mode 진행 중 → run 안내)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V06_SRC);
  run(c.repo, "start", []);
  emit("v06-02-mode-active", "guard start … ; guard mode   (task mode active)", run(c.repo, "mode", []), null);
}
// v06-03: receipts — 비어있음 → 생성 안내, exit 0(read-only 조회)
{
  const c = track(newCase());
  emit("v06-03-receipts-empty", "guard receipts   (none yet)", run(c.repo, "receipts", []), null);
}
// v06-04~07: receipts — 고정 파일명으로 2개 저장(이름 내림차순=최신: B>A) 후 list/latest/cat/dir
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V06_SRC);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  run(c.repo, "start", []); // baseline: contract.yaml + src/a.ts ambient
  run(c.repo, "receipt", ["--format", "json", "--out", join(".agent-guard", "receipts", "receipt-A.json")]);
  run(c.repo, "receipt", ["--format", "json", "--out", join(".agent-guard", "receipts", "receipt-B.json")]);
  {
    const r = run(c.repo, "receipts", []); r.stdout = normTs(r.stdout);
    emit("v06-04-receipts-list", "guard receipts   (2 saved → 최신순 목록)", r, null);
  }
  {
    const r = run(c.repo, "receipts", ["--latest"]); r.stdout = normTs(r.stdout);
    emit("v06-05-receipts-latest", "guard receipts --latest", r, null);
  }
  {
    const r = run(c.repo, "receipts", ["--cat"]); r.stdout = normTs(r.stdout);
    emit("v06-06-receipts-cat", "guard receipts --cat   (최신 receipt 내용)", r, null);
  }
  {
    const r = run(c.repo, "receipts", ["--dir"]);
    emit("v06-07-receipts-dir", "guard receipts --dir", r, null, c.base);
  }
}

// ───────────────────────────── Sprint 5 (v0.7): presets/draft/review/prompt변종/client-md/sign/audit/dashboard/approve/export ─────────────────────────────
// 신규 명령 대량 추가. 서명(키)은 비결정적 → error path 만 golden, happy path 는 smoke/dogfood.

// 산출물 저장(타임스탬프 정규화 옵션) — saveReceipt/saveSession 패턴 계승.
function saveArtifact(caseName: string, repo: string, relPath: string, outName: string, tsNorm: boolean): void {
  const sp = join(repo, relPath);
  if (!existsSync(sp)) return;
  let s = readFileSync(sp, "utf8");
  if (tsNorm) s = normTs(s);
  writeFileSync(join(goldenDir, caseName, outName), s);
}
// receipt 1개(고정명) 가진 fixture — audit/export/approve/dashboard/client-md 공용.
function v07Receipt(): { base: string; repo: string; contract: string } {
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V06_SRC);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  run(c.repo, "start", []);
  run(c.repo, "receipt", ["--format", "json", "--out", join(".agent-guard", "receipts", "receipt-A.json")]);
  return c;
}

// v07-01: presets 목록
{
  const c = track(newCase());
  emit("v07-01-presets", "guard presets", run(c.repo, "presets", []), null);
}
// v07-02/03: init strict / relaxed (생성물 캡처)
{
  const base = initBase();
  emit("v07-02-init-strict", "guard init --preset strict", run(base, "init", ["--preset", "strict"]), null, base);
  saveCreated("v07-02-init-strict", base);
}
{
  const base = initBase();
  emit("v07-03-init-relaxed", "guard init --preset relaxed", run(base, "init", ["--preset", "relaxed"]), null, base);
  saveCreated("v07-03-init-relaxed", base);
}
// v07-04: draft-contract — repo 스캔(app/src/docs 존재) → stdout 초안
{
  const c = track(newCase());
  for (const d of ["app", "src", "docs"]) mkdirSync(join(c.repo, d), { recursive: true });
  emit("v07-04-draft-scan", "guard draft-contract   (repo 스캔)", run(c.repo, "draft-contract", []), null);
}
// v07-05: draft-contract --preset strict → template 그대로 stdout
{
  const c = track(newCase());
  emit("v07-05-draft-preset-strict", "guard draft-contract --preset strict", run(c.repo, "draft-contract", ["--preset", "strict"]), null);
}
// v07-06: review (strict 계약 대상)
{
  const c = track(newCase());
  const contract = readFileSync(join(repoRoot, "templates", "strict.yaml"), "utf8");
  writeFileSync(c.contract, contract);
  emit("v07-06-review-strict", "guard review --contract contract.yaml", run(c.repo, "review", ["--contract", c.contract]), contract);
}
// v07-07/08: prompt --cursor / --claude (case-07 default 와 머리말만 다름)
{
  const c = track(newCase());
  const contract =
    `id: gold-prompt\ntitle: prompt block test\nbranch:\n  expected: main\n` +
    `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - "package.json"\n` +
    `forbidden_actions:\n  - push\n  - deploy\n` +
    `required_checks:\n  commands:\n    - name: tsc\n      command: 'tsc --noEmit'\n      required_exit: 0\n`;
  writeFileSync(c.contract, contract);
  emit("v07-07-prompt-cursor", "guard prompt --cursor --contract contract.yaml", run(c.repo, "prompt", ["--cursor", "--contract", c.contract]), contract);
  emit("v07-08-prompt-claude", "guard prompt --claude --contract contract.yaml", run(c.repo, "prompt", ["--claude", "--contract", c.contract]), contract);
}
// v07-09: receipt --format client-md (고객 전달용 — 내용 정규화 저장)
{
  const c = v07Receipt();
  const r = run(c.repo, "receipt", ["--format", "client-md", "--out", join(".agent-guard", "receipts", "client.md")]);
  emit("v07-09-receipt-client-md", "guard receipt --format client-md --out client.md", r, null);
  saveArtifact("v07-09-receipt-client-md", c.repo, join(".agent-guard", "receipts", "client.md"), "created-client.md", true);
}
// v07-10/11/12: audit / audit-empty / audit --json
{
  const c = v07Receipt();
  emit("v07-10-audit", "guard audit   (1 receipt)", run(c.repo, "audit", []), null);
  emit("v07-12-audit-json", "guard audit --json", run(c.repo, "audit", ["--json"]), null);
}
{
  const c = track(newCase());
  emit("v07-11-audit-empty", "guard audit   (no receipts)", run(c.repo, "audit", []), null);
}
// v07-13/14: export slack / json
{
  const c = v07Receipt();
  emit("v07-13-export-slack", "guard export --format slack --receipt receipt-A.json",
    run(c.repo, "export", ["--format", "slack", "--receipt", join(".agent-guard", "receipts", "receipt-A.json")]), null);
  const ej = run(c.repo, "export", ["--format", "json", "--receipt", join(".agent-guard", "receipts", "receipt-A.json")]);
  ej.stdout = normTs(ej.stdout);
  emit("v07-14-export-json", "guard export --format json --receipt receipt-A.json", ej, null);
}
// v07-15/16: approve / approvals (golden 환경엔 git user 미설정 → approver unknown)
{
  const c = v07Receipt();
  const ap = run(c.repo, "approve", ["--receipt", join(".agent-guard", "receipts", "receipt-A.json"), "--note", "검수 완료"]);
  emit("v07-15-approve", "guard approve --receipt receipt-A.json --note '검수 완료'", ap, null);
  saveArtifact("v07-15-approve", c.repo, join(".agent-guard", "receipts", "receipt-A.json.approval.json"), "created-approval.json", true);
  const al = run(c.repo, "approvals", []);
  al.stdout = normTs(al.stdout);
  emit("v07-16-approvals", "guard approvals", al, null);
}
// v07-17: dashboard (stdout 메시지 + HTML marker)
{
  const c = v07Receipt();
  emit("v07-17-dashboard", "guard dashboard   (1 receipt → static HTML)", run(c.repo, "dashboard", []), null);
  saveArtifact("v07-17-dashboard", c.repo, join(".agent-guard", "dashboard.html"), "created-dashboard.html", true);
}
// v07-18/19/20: signing error paths (키 비결정적 → happy path 는 smoke/dogfood)
{
  const c = track(newCase());
  emit("v07-18-sign-no-key", "guard sign --receipt f.txt   (no keys init → exit 2)", run(c.repo, "sign", ["--receipt", "f.txt"]), null);
}
{
  const c = track(newCase());
  emit("v07-19-verifysig-no-sidecar", "guard verify-signature --receipt f.txt   (no .sig.json → exit 2)", run(c.repo, "verify-signature", ["--receipt", "f.txt"]), null);
}
{
  const c = track(newCase());
  emit("v07-20-export-no-format", "guard export --receipt f.txt   (no --format → exit 2)", run(c.repo, "export", ["--receipt", "f.txt"]), null);
}

// ───────────────────────────── 인덱스 + 정리 ─────────────────────────────

const indexLines = [
  "# agent-guard v0.1 golden baseline (A0.5)",
  "",
  `- branch: v0.1-verify-check-split`,
  `- 캡처 케이스: ${captures.length}개`,
  `- 결정론: 고정 git identity(ci/ci@local) + 고정 DATE(${FIXED_DATE}) → headHash 재현`,
  `- 정규화(스냅샷 한정): $HOME→<HOME>, ${TMP}/ag-gold-*→<FIXTURE>`,
  "",
  "| case | command | exit |",
  "|---|---|---|",
  ...captures.map((c) => `| ${c.name} | \`${c.cmdline}\` | ${c.exit} |`),
  "",
];
writeFileSync(join(goldenDir, "INDEX.md"), indexLines.join("\n"));

for (const b of bases) {
  try { rmSync(b, { recursive: true, force: true }); } catch { /* tmp 정리 best-effort */ }
}

console.log(`\ngolden 캡처 완료: ${captures.length} cases → test/golden/`);
for (const c of captures) console.log(`  ${c.name.padEnd(34)} exit=${c.exit}  ${c.cmdline}`);
console.log("");
