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
