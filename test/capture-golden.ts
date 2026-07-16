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
// --check: 골든 재생성(write) 대신 현재 출력을 봉인 골든과 비교(diff). drift 시 exit 1. (test 잠금 — embed/test #2)
const CHECK = process.argv.includes("--check");
const checkFails: string[] = [];

if (!existsSync(tsxBin)) {
  console.error(`ENV ERROR: tsx 없음 (${tsxBin}). 먼저 'npm install'.`);
  process.exit(1);
}
mkdirSync(goldenDir, { recursive: true });

const TMP = tmpdir();
// HOME 을 격리 임시 디렉터리로 봉인한다(P0-1 후속).
//   이유: doctor 의 관찰 진단이 `~/.claude/settings.json` 의 전역 capture 훅을 읽는다(정상 동작이다.
//   전역 훅은 이 저장소도 실제로 관찰하니까). 그런데 진짜 HOME 을 쓰면 개발자가 전역 훅을 깔았는지에
//   따라 골든이 달라진다(결정론 붕괴). 격리 HOME 은 비어 있으므로 골든은 픽스처 저장소에만 의존한다.
const HOME = mkdtempSync(join(TMP, "ag-gold-home-"));
const FIXED_DATE = "2025-01-01T00:00:00 +0000";

// 호스트 git config·GIT_* 차단 + 고정 DATE + 격리 HOME 으로 결정론화.
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
  // 0.9.1: doctor 의 npm latest 조회(네트워크)를 끈다 → 결정론. 현재 버전 라인은 normVolatile 가 <VER> 로 정규화.
  AGENT_RECEIPT_NO_NET: "1",
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
// Sprint6: receipt/audit-pack/attest 등은 environment(node/git/npm/os/version) + wall-clock 타임스탬프 +
// 스탬프 파일명(audit-packs/<ts>/, receipt-<ts>.json)을 포함한다 — 머신/시간마다 바뀌므로 정규화한다.
// contentHash·contractHash·policyHash·headHash 는 고정 git date + 고정 파일내용으로 결정론적 → 정규화 안 함(진짜 값 유지).
function normVolatile(s: string): string {
  let out = s;
  // 타임스탬프: ISO(콜론) + 파일 스탬프(대시) 둘 다 <TS>
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TS>");
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g, "<TS>");
  // environment(JSON)
  out = out.replace(/"nodeVersion": "[^"]*"/g, '"nodeVersion": "<NODE>"');
  out = out.replace(/"gitVersion": ("[^"]*"|null)/g, '"gitVersion": "<GIT>"');
  out = out.replace(/"npmVersion": ("[^"]*"|null)/g, '"npmVersion": "<NPM>"');
  out = out.replace(/"release": "[^"]*"/g, '"release": "<OSREL>"');
  out = out.replace(/"agentReceiptVersion": "[^"]*"/g, '"agentReceiptVersion": "<VER>"');
  // agentSession(#7): 실행 세션마다 다르고 CI(사람)에선 null → UUID·null 둘 다 <SESSION>으로 정규화(실행환경 무관).
  out = out.replace(/"agentSession": ("[^"]*"|null)/g, '"agentSession": "<SESSION>"');
  out = out.replace(/"toolVersion": ("[^"]*"|null)/g, '"toolVersion": "<VER>"');
  out = out.replace(/"version": "[0-9][^"]*"/g, '"version": "<VER>"');
  // doctor 설치 진단(0.9.1): '현재 버전 : <semver>' → <VER>(버전 bump churn 방지), '실행 파일 : <path>' → <BIN>(clone 경로 무관).
  out = out.replace(/(현재 버전 : )[0-9]\S*/g, "$1<VER>");
  out = out.replace(/(실행 파일 : ).*/g, "$1<BIN>");
  // environment(markdown)
  out = out.replace(/- node: .*?  git: .*/g, "- node: <NODE>  npm: <NPM>  git: <GIT>");
  out = out.replace(/- os: \S+\/\S+ \(.*\)/g, "- os: <OS>");
  out = out.replace(/- agent-receipt: \S+  contractHash/g, "- agent-receipt: <VER>  contractHash");
  out = out.replace(/- Environment: node .*/g, "- Environment: <ENV>");
  return out;
}

function norm(s: string): string {
  if (!s) return s;
  let out = s;
  out = out.replace(new RegExp(escapeRe(TMP) + "/ag-gold-[^\\s\"']*", "g"), "<FIXTURE>");
  out = out.split(repoRoot).join("<REPO>"); // repo 절대경로(clone/rename 위치) → <REPO>: 위치·폴더명 독립(HOME 치환 전에)
  if (HOME) out = out.split(HOME).join("<HOME>");
  out = normVolatile(out);
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
  const curExit = `${res.status}\n`;
  const curStdout = norm(pre(res.stdout ?? ""));
  const curStderr = norm(pre(res.stderr ?? ""));
  if (CHECK) {
    // 비교 모드: 봉인된 골든과 현재 출력(정규화) 대조. 행동 계약(exit/stdout/stderr)만 비교(cmd/contract=입력).
    captures.push({ name, cmdline, exit: res.status });
    const cmp = (file: string, cur: string): void => {
      const p = join(dir, file);
      const expected = existsSync(p) ? readFileSync(p, "utf8") : file === "stderr.txt" ? "" : null;
      if (expected === null) {
        checkFails.push(`${name}/${file}: 골든 없음(신규 케이스 — 먼저 재생성 필요)`);
        return;
      }
      if (cur !== expected) checkFails.push(`${name}/${file}: 불일치`);
    };
    cmp("exit_code.txt", curExit);
    cmp("stdout.txt", curStdout);
    cmp("stderr.txt", curStderr);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cmd.txt"), cmdline + "\n");
  writeFileSync(join(dir, "exit_code.txt"), curExit);
  writeFileSync(join(dir, "stdout.txt"), curStdout);
  const stderrPath = join(dir, "stderr.txt");
  if (curStderr.length) writeFileSync(stderrPath, curStderr);
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
  s = norm(s); // 타임스탬프·environment(node/git/npm/os/version)·휘발 경로 정규화
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
  s = norm(s); // environment/휘발 경로/스탬프 정규화(결정론)
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
// v07-21: status — tool output(receipts/dashboard)을 변경 카운트에서 제외(verify 와 일관) — QA 정합성 가드.
// 제외 실패 시 untracked 가 4 로 잡혀 golden 이 깨진다(회귀 검출).
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard", "receipts"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V06_SRC);
  writeFileSync(join(c.repo, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(c.repo, ".agent-guard", "receipts", "r.json"), "{}\n");
  writeFileSync(join(c.repo, ".agent-guard", "dashboard.html"), "<html></html>\n");
  emit("v07-21-status-excludes-tooloutput", "guard status   (receipts/dashboard 제외 → untracked 2)", run(c.repo, "status", []), null);
}

// ───────────────────────────── Sprint 6 (v0.8): 감사 프로토콜 — policy/begin/done/commit-check/audit-pack/ledger/replay/attest/incident/report-type/export확장/help --all ─────────────────────────────
// 신규 명령 대량. environment(node/git/npm/os/version)+wall-clock+스탬프 파일명은 norm() 으로 정규화(결정론).
// contentHash/contractHash/policyHash/headHash 는 고정 git date+고정 파일내용으로 결정론적 → 실제 값 유지.

const S6_CONTRACT =
  `id: s6\ntitle: sprint6 audit\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;
const S6_POLICY =
  `requireReceipt: true\nrequireClaims: false\nrequireCheck: false\n` +
  `forbidAlways:\n  - ".env*"\nrequireApprovalFor:\n  - "package-lock.json"\nprotectAlways:\n  - "exports/**"\n`;

// 계약+정책+baseline+in-scope 변경(src/a.ts) + 고정명 receipt-A.json 을 갖춘 fixture.
function s6Fixture(): { base: string; repo: string } {
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  run(c.repo, "start", []); // baseline: contract.yaml/policy.yaml ambient
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n"); // start 이후 신규 in-scope
  run(c.repo, "receipt", ["--out", join(".agent-guard", "receipts", "receipt-A.json")]); // 고정명 receipt
  return { base: c.base, repo: c.repo };
}

// s6-01: policy init (promptia) — 생성물 캡처
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  const r = run(c.repo, "policy", ["init", "--profile", "promptia"]);
  emit("s6-01-policy-init", "guard policy init --profile promptia", r, null, c.base);
  saveArtifact("s6-01-policy-init", c.repo, join(".agent-guard", "policy.yaml"), "created-policy.yaml", false);
}
// s6-02: policy show
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  emit("s6-02-policy-show", "guard policy show", run(c.repo, "policy", ["show"]), null);
}
// s6-03: policy check — forbidAlways(.env) 닿음 → FAIL
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n");
  emit("s6-03-policy-check-forbid", "guard policy check   (.env touched → FAIL)", run(c.repo, "policy", ["check"]), null);
}
// s6-04: help --all
{
  const c = track(newCase());
  emit("s6-04-help-all", "guard help --all", run(c.repo, "help", ["--all"]), null);
}
// s6-05: verify(human) + policy tripwire — .env(forbidAlways/denied) 닿음
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  writeFileSync(c.contract, S6_CONTRACT);
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n");
  emit("s6-05-verify-tripwire", "guard verify --contract contract.yaml   (policy tripwire)",
    run(c.repo, "verify", ["--contract", c.contract]), S6_CONTRACT);
}
// s6-06: verify --json — policy 있어도 14키 유지(회귀 가드)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  writeFileSync(c.contract, S6_CONTRACT);
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n");
  emit("s6-06-verify-json-14keys-policy", "guard verify --json   (policy 있어도 14키)",
    run(c.repo, "verify", ["--json", "--contract", c.contract]), S6_CONTRACT);
}
// s6-07: explain + policy tripwire
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  writeFileSync(c.contract, S6_CONTRACT);
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, "src", "x.ts"), "export const x=1;\n");
  emit("s6-07-explain-policy", "guard explain --contract contract.yaml   (policy)",
    run(c.repo, "explain", ["--contract", c.contract]), S6_CONTRACT);
}
// s6-08: begin (baseline + prompt)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  emit("s6-08-begin", "guard begin   (policy+baseline+prompt)", run(c.repo, "begin", []), null);
}
// s6-09: done (+ ledger) — stamped receipt 경로 <TS> 정규화
{
  const f = s6Fixture();
  const r = run(f.repo, "done", ["--ledger"]);
  emit("s6-09-done-ledger", "guard done --ledger", r, null);
}
// s6-10: commit-check PASS (+ 트레일러)
{
  const f = s6Fixture();
  emit("s6-10-commit-check-pass", "guard commit-check   (PASS + trailer)", run(f.repo, "commit-check", []), null);
}
// s6-11: commit-check FAIL — forbidAlways(.env) 닿음
{
  const f = s6Fixture();
  writeFileSync(join(f.repo, ".env.local"), "SECRET=1\n");
  emit("s6-11-commit-check-fail", "guard commit-check   (.env → 차단)", run(f.repo, "commit-check", []), null);
}
// s6-12: trailer 단독
{
  const f = s6Fixture();
  emit("s6-12-trailer", "guard trailer", run(f.repo, "trailer", []), null);
}
// s6-13: audit-pack (+ 산출물 정규화 캡처)
{
  const f = s6Fixture();
  const r = run(f.repo, "audit-pack", ["--out", join(".agent-guard", "audit-packs", "PK")]);
  emit("s6-13-audit-pack", "guard audit-pack --out audit-packs/PK", r, null);
  saveArtifact("s6-13-audit-pack", f.repo, join(".agent-guard", "audit-packs", "PK", "manifest.json"), "created-manifest.json", false);
  saveArtifact("s6-13-audit-pack", f.repo, join(".agent-guard", "audit-packs", "PK", "environment.json"), "created-environment.json", false);
}
// s6-14: replay (round-trip PASS)
{
  const f = s6Fixture();
  run(f.repo, "audit-pack", ["--out", join(".agent-guard", "audit-packs", "PK")]);
  emit("s6-14-replay", "guard replay --pack audit-packs/PK", run(f.repo, "replay", ["--pack", join(".agent-guard", "audit-packs", "PK")]), null);
}
// s6-15: attest (--receipt receipt-A.json)
{
  const f = s6Fixture();
  const r = run(f.repo, "attest", ["--receipt", join(".agent-guard", "receipts", "receipt-A.json")]);
  emit("s6-15-attest", "guard attest --receipt receipt-A.json", r, null);
}
// s6-16: ledger rebuild + ledger
{
  const f = s6Fixture();
  run(f.repo, "ledger", ["rebuild"]);
  emit("s6-16-ledger", "guard ledger rebuild ; guard ledger", run(f.repo, "ledger", []), null);
}
// s6-17: incident
{
  const f = s6Fixture();
  emit("s6-17-incident", "guard incident", run(f.repo, "incident", []), null);
}
// s6-18: export github-pr / otel / langfuse (미리보기 — 전송 없음)
{
  const f = s6Fixture();
  const rcpt = join(".agent-guard", "receipts", "receipt-A.json");
  emit("s6-18-export-github-pr", "guard export --format github-pr --receipt receipt-A.json", run(f.repo, "export", ["--format", "github-pr", "--receipt", rcpt]), null);
  emit("s6-19-export-otel", "guard export --format otel --receipt receipt-A.json", run(f.repo, "export", ["--format", "otel", "--receipt", rcpt]), null);
  emit("s6-20-export-langfuse", "guard export --format langfuse --receipt receipt-A.json", run(f.repo, "export", ["--format", "langfuse", "--receipt", rcpt]), null);
}
// s6-21: report --type audit / client
{
  const f = s6Fixture();
  // 단일 실행: runVerify 는 audit.md 를 쓰기 전에 끝나므로 PASS. (두 번 실행하면 audit.md 가 outOfScope 로 잡힘)
  const r = run(f.repo, "report", ["--type", "audit", "--out", "audit.md"]);
  emit("s6-21-report-audit", "guard report --type audit --out audit.md", r, null);
  saveArtifact("s6-21-report-audit", f.repo, "audit.md", "created-audit.md", false);
}
// s6-22: receipt --redact (비밀 없음 → 0건, best-effort 고지)
{
  const f = s6Fixture();
  emit("s6-22-receipt-redact", "guard receipt --redact --out r2.json",
    run(f.repo, "receipt", ["--redact", "--out", join(".agent-guard", "receipts", "r2.json")]), null);
}

// ───────────────────────────── v0.9 C1: begin --kind / session kind ─────────────────────────────
// kind 는 session.json·receipt sidecar 에만(verify --json 14키 비접촉). 무kind 경로는 기존과 동일(기존 golden 불변).

// v09-01: begin --kind recon (fresh baseline) → recon 운영원칙 + close-recon 종료안내
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  emit("v09-01-begin-kind-recon", "guard begin --kind recon", run(c.repo, "begin", ["--kind", "recon"]), null);
}
// v09-02: begin --kind implementation → implementation 원칙 + finish 종료안내
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), S6_POLICY);
  emit("v09-02-begin-kind-impl", "guard begin --kind implementation", run(c.repo, "begin", ["--kind", "implementation"]), null);
}
// v09-03: begin — 기존 baseline 존재 → 강화된 전환 경고(exit 0)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "start", []); // 기존 baseline
  emit("v09-03-begin-existing-baseline", "guard start … ; guard begin   (기존 baseline → 전환 경고)", run(c.repo, "begin", []), null);
}
// v09-04: begin --kind bogus → 검증 실패 exit 2
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  emit("v09-04-begin-kind-bogus", "guard begin --kind bogus   (검증 실패)", run(c.repo, "begin", ["--kind", "bogus"]), null);
}
// v09-05: start --kind recon → session.json 에 kind 기록(생성물 캡처)
{
  const c = track(newCase());
  writeFileSync(c.contract, S6_CONTRACT);
  const r = run(c.repo, "start", ["--kind", "recon", "--contract", c.contract]);
  emit("v09-05-start-kind", "guard start --kind recon --contract contract.yaml", r, S6_CONTRACT);
  saveSession("v09-05-start-kind", c.repo);
}
// v09-06: status — kind 세션 → '작업 종류' 라인
{
  const c = track(newCase());
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  emit("v09-06-status-kind", "guard start --kind implementation … ; guard status",
    run(c.repo, "status", ["--contract", c.contract]), S6_CONTRACT);
}
// v09-07: receipt — kind 세션 → receipt.session.kind (생성물 캡처)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  emit("v09-07-receipt-kind", "guard start --kind implementation … ; guard receipt --out r.json",
    run(c.repo, "receipt", ["--out", "r.json", "--contract", c.contract]), S6_CONTRACT);
  saveReceipt("v09-07-receipt-kind", c.repo, "r.json");
}
// v09-08: mode — kind 세션 → kind 표시
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "start", ["--kind", "recon"]);
  emit("v09-08-mode-kind", "guard start --kind recon … ; guard mode", run(c.repo, "mode", []), null);
}

// ───────────────────────────── v0.9 C2: close-recon ─────────────────────────────
// 정찰 세션 1발 종료(변경 0일 때만 receipt+audit-pack+reset). 구현/dirty 는 거부. core 추출은 기존 출력 불변.

// v09-09: close-recon — clean recon 세션 → receipt+audit-pack+reset, exit 0 (스탬프 <TS> 정규화)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "begin", ["--kind", "recon"]); // baseline kind=recon, 변경 0
  emit("v09-09-close-recon-clean", "guard begin --kind recon ; (변경 0) ; guard close-recon",
    run(c.repo, "close-recon", []), null);
}
// v09-10: close-recon — 변경 있음 → 거부(reset 안 함), exit 1
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "begin", ["--kind", "recon"]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n"); // 변경 발생
  emit("v09-10-close-recon-dirty", "guard begin --kind recon ; (src/a.ts 변경) ; guard close-recon",
    run(c.repo, "close-recon", []), null);
}
// v09-11: close-recon — implementation 세션 → 자동 정리 거부, exit 1
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "begin", ["--kind", "implementation"]);
  emit("v09-11-close-recon-impl-refuse", "guard begin --kind implementation ; guard close-recon   (구현 세션 거부)",
    run(c.repo, "close-recon", []), null);
}

// ───────────────────────────── v0.9 C3: prepare-commit / finish ─────────────────────────────
// 자동 git 0 — 복붙 블록 생성만. 커밋 블록/reset 블록 물리 분리. denied/진짜 범위 밖/브랜치/NUL → 블록 생략.
const V09_LINKED =
  `id: s6-linked\ntitle: linked test\nbranch:\n  expected: main\n` +
  `scope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\n` +
  `linked_test_paths:\n    - "tests/**"\nrequired_checks:\n  commands: []\n`;

// v09-12: prepare-commit PASS — in-scope 변경 → 커밋 블록 + reset 블록 분리(contentHash 결정론)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  emit("v09-12-prepare-commit-pass", "guard start --kind implementation … ; guard prepare-commit",
    run(c.repo, "prepare-commit", ["--contract", c.contract]), S6_CONTRACT);
}
// focus-01: 리뷰 압축 + 확인 신호 (council 2026-07-03 R1~R3) — total>=4 발동·티어 정렬·red flag 결정론
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  mkdirSync(join(c.repo, "tests"), { recursive: true });
  const FOCUS_CONTRACT =
    `id: s6-focus\ntitle: review focus\n` +
    `scope:\n  allowed_paths:\n    - "src/**"\n    - "tests/**"\n    - "package.json"\n  denied_paths: []\n` +
    `required_checks:\n  commands: []\n`;
  writeFileSync(c.contract, FOCUS_CONTRACT);
  // 기준 커밋: package.json(dep a)·src/big.ts(소형) — 이후 변경이 HEAD diff 로 잡히게
  writeFileSync(join(c.repo, "package.json"), JSON.stringify({ name: "fx", dependencies: { a: "1.0.0" } }, null, 2) + "\n");
  writeFileSync(join(c.repo, "src", "big.ts"), "export const b = 0;\n");
  git(c.repo, ["add", "."]);
  git(c.repo, ["commit", "-q", "-m", "seed"]);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  // 변경 4개: 의존성 추가(T2+신호)·대형 diff(T3)·신규 src(T4)·신규 테스트에 skip 추가(신호)
  writeFileSync(join(c.repo, "package.json"), JSON.stringify({ name: "fx", dependencies: { a: "1.0.0", b: "2.0.0" } }, null, 2) + "\n");
  writeFileSync(join(c.repo, "src", "big.ts"), Array.from({ length: 90 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  writeFileSync(join(c.repo, "src", "newmod.ts"), "export const n = 1;\n");
  writeFileSync(join(c.repo, "tests", "t.test.ts"), "it.skip('later', () => {});\n");
  emit("focus-01-prepare-commit-review-pack", "4+ 파일 변경 ; guard prepare-commit   (우선 검토 후보 + 확인 신호)",
    run(c.repo, "prepare-commit", ["--contract", c.contract]), FOCUS_CONTRACT);
}
// v09-13: prepare-commit BLOCK — 진짜 범위 밖 → 커밋 블록 생략, exit 1
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, "outsider.txt"), "out of scope\n");
  emit("v09-13-prepare-commit-block-oos", "guard … ; (outsider.txt) ; guard prepare-commit   (범위 밖 → 차단)",
    run(c.repo, "prepare-commit", ["--contract", c.contract]), S6_CONTRACT);
}
// v09-14: prepare-commit + linked test — verify 는 oos 로 보지만 사람 확인하에 포함(--include-linked-tests)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  mkdirSync(join(c.repo, "tests"), { recursive: true });
  writeFileSync(c.contract, V09_LINKED);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(c.repo, "tests", "a.test.ts"), "test\n");
  emit("v09-14-prepare-commit-linked", "guard … ; (src + tests/) ; guard prepare-commit --include-linked-tests",
    run(c.repo, "prepare-commit", ["--include-linked-tests", "--contract", c.contract]), V09_LINKED);
}
// v09-15: finish PASS — 4단계 라벨 + 커밋 블록 (receipt/audit-pack 스탬프 <TS> 정규화)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  emit("v09-15-finish-pass", "guard … ; guard finish", run(c.repo, "finish", ["--contract", c.contract]), S6_CONTRACT);
}
// v09-16: finish BLOCKED — denied(.env) → commit-check 차단, 커밋 블록 생략, exit 1
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, S6_CONTRACT);
  run(c.repo, "start", ["--kind", "implementation", "--contract", c.contract]);
  writeFileSync(join(c.repo, ".env.local"), "SECRET=1\n");
  emit("v09-16-finish-blocked", "guard … ; (.env.local) ; guard finish   (commit-check 차단)",
    run(c.repo, "finish", ["--contract", c.contract]), S6_CONTRACT);
}

// ───────────────────────────── v0.9 C4: linked test 분류(commit-check/lint 표시) ─────────────────────────────
// linked_test_paths 정의시에만 분류 표시. verify --json outOfScope 14키 의미 불변(s6 등 기존 golden 불변).

// v09-17: commit-check — linked 가드 테스트 touched → advisory(verify 는 여전히 oos 로 차단, exit 1)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  mkdirSync(join(c.repo, "tests"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), V09_LINKED);
  run(c.repo, "start", ["--kind", "implementation"]);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(c.repo, "tests", "a.test.ts"), "test\n");
  emit("v09-17-commit-check-linked", "guard … ; (src + tests/) ; guard commit-check   (linked 가드 테스트 advisory)",
    run(c.repo, "commit-check", []), null);
}
// v09-18: lint — linked_test_paths 있고 expected_linked_tests 없음 → advisory
{
  const c = track(newCase());
  writeFileSync(c.contract, V09_LINKED);
  emit("v09-18-lint-linked", "guard lint --contract contract.yaml   (linked_test_paths, expected 없음)",
    run(c.repo, "lint", ["--contract", c.contract]), V09_LINKED);
}

// ───────────────────────────── v0.9 C5: policy modes + modeClaims/externalActions self-report ─────────────────────────────
// mode 는 standard 아닐 때만 표시(기존 standard policy golden 불변). self-report 는 검증 불가 라벨 + mismatch 집계 안 함.
const V09_POLICY_MF =
  `mode: measure_first\nrequireReceipt: false\nrequireClaims: false\nrequireCheck: false\n` +
  `forbidAlways:\n  - ".env*"\n`;
const V09_CLAIMS_CONTRACT =
  `id: s6-claims\nscope:\n  allowed_paths:\n    - "src/**"\n  denied_paths:\n    - ".env*"\nrequired_checks:\n  commands: []\n`;

// v09-19: policy show — mode=measure_first → mode 라인 표시
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), V09_POLICY_MF);
  emit("v09-19-policy-show-mode", "guard policy show   (mode=measure_first)", run(c.repo, "policy", ["show"]), null);
}
// v09-20: commit-check — measure_first self-report 체크리스트 advisory (verify PASS → OK + trailer)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  writeFileSync(join(c.repo, ".agent-guard", "policy.yaml"), V09_POLICY_MF);
  run(c.repo, "start", []);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  emit("v09-20-commit-check-measure-first", "guard … ; guard commit-check   (mode=measure_first self-report)",
    run(c.repo, "commit-check", []), null);
}
// v09-21: claims — modeClaims + externalActions self-report 표시(검증 불가 라벨, mismatch 0)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(c.contract, V09_CLAIMS_CONTRACT);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  const claim = join(c.base, "claim.json");
  writeFileSync(claim, JSON.stringify({
    changedFiles: ["src/a.ts"], newFiles: ["src/a.ts"], deniedHits: [], tests: true, summary: "measure-only",
    modeClaims: { aiCall: 0, dbWrite: 0, studioLogOnly: true, scoreReplacement: 0, coverage: "partial" },
    externalActions: { memoryWrite: 0, npmPublish: 0, push: 0, deploy: 0 },
  }, null, 2) + "\n");
  emit("v09-21-claims-self-report", "guard claims --file claim.json   (modeClaims + externalActions self-report)",
    run(c.repo, "claims", ["--file", claim, "--contract", c.contract]), V09_CLAIMS_CONTRACT, c.base);
}

// ───────────────────────────── v0.9 C6: note / decisions (코드 변경 없는 증거) ─────────────────────────────
// notes/ · decisions/ 는 tool 산출(verify 제외) → audit-pack 에 포함. 파일명 스탬프는 <TS> 정규화.

// v09-22: note --type recon → notes/ 저장
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  emit("v09-22-note-recon", "guard note --type recon --message '정찰: 변경 불필요'",
    run(c.repo, "note", ["--type", "recon", "--message", "정찰: 변경 불필요"]), null);
}
// v09-23: note --type no-code-decision → decisions/ 저장
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  emit("v09-23-note-decision", "guard note --type no-code-decision --message '이미 구현됨 — 변경 불필요'",
    run(c.repo, "note", ["--type", "no-code-decision", "--message", "이미 구현됨 — 변경 불필요"]), null);
}
// v09-24: note --type bogus → exit 2
{
  const c = track(newCase());
  emit("v09-24-note-bogus", "guard note --type bogus   (검증 실패)", run(c.repo, "note", ["--type", "bogus"]), null);
}
// v09-25: audit-pack — note 포함(manifest 에 note-recon-<TS>.json)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "start", []); // baseline: contract.yaml ambient
  run(c.repo, "note", ["--type", "recon", "--message", "정찰 결과"]);
  const r = run(c.repo, "audit-pack", ["--out", join(".agent-guard", "audit-packs", "PK")]);
  emit("v09-25-audit-pack-with-note", "guard start … ; guard note --type recon … ; guard audit-pack   (note 포함)", r, null);
  saveArtifact("v09-25-audit-pack-with-note", c.repo, join(".agent-guard", "audit-packs", "PK", "manifest.json"), "created-manifest.json", false);
}

// ───────────────────────────── v0.9 C7: release-check / next ─────────────────────────────
// release-check 는 read-only(push/deploy/checkout/reset 0). 고정 DATE 로 hash 결정론. next 는 단일 명령 추천.

// v09-26: release-check --base rel-base — ahead/behind·changed·commits·risk(휴리스틱)·rollbackBase
{
  const c = track(newCase()); // base commit(f.txt) on main
  git(c.repo, ["branch", "rel-base"]); // base ref @ base commit
  mkdirSync(join(c.repo, "docs"), { recursive: true });
  writeFileSync(join(c.repo, "docs", "x.md"), "doc\n");
  git(c.repo, ["add", "docs/x.md"]);
  git(c.repo, ["commit", "-q", "-m", "docs: add x"]);
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  git(c.repo, ["add", "src/a.ts"]);
  git(c.repo, ["commit", "-q", "-m", "feat: add a"]);
  emit("v09-26-release-check", "guard release-check --base rel-base", run(c.repo, "release-check", ["--base", "rel-base"]), null);
}
// v09-27: release-check (no --base) → exit 2
{
  const c = track(newCase());
  emit("v09-27-release-check-no-base", "guard release-check   (no --base → exit 2)", run(c.repo, "release-check", []), null);
}
// v09-28: next — 계약 있음, session 없음 → begin 추천
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  emit("v09-28-next-no-session", "guard next   (계약 있음, session 없음 → begin)", run(c.repo, "next", []), null);
}
// v09-29: next — session 활성 + in-scope 변경 → finish 추천
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  mkdirSync(join(c.repo, "src"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S6_CONTRACT);
  run(c.repo, "start", []);
  writeFileSync(join(c.repo, "src", "a.ts"), "export const a = 1;\n");
  emit("v09-29-next-changes", "guard start … ; (src/a.ts) ; guard next   (변경 → finish)", run(c.repo, "next", []), null);
}

// ───────────────────────────── v0.9.1: version command / doctor 버전진단 / next FAIL 요약 ─────────────────────────────
// 실사용 결함 패치. doctor 케이스(v1-04/v1-05/v05-04)는 설치/버전 섹션이 붙어 재캡처됨(no-net + <VER> 정규화로 결정론).

// v091-01..03: --version / -v / version → 동일 버전(계약/git 불필요). 버전 문자열은 케이스-로컬 <VER> 정규화.
for (const [nm, flag, label] of [
  ["v091-01-version-flag", "--version", "guard --version   (no git repo, no contract)"],
  ["v091-02-version-v", "-v", "guard -v   (no git repo, no contract)"],
  ["v091-03-version-word", "version", "guard version   (no git repo, no contract)"],
] as const) {
  const base = initBase(); // 비-repo + 계약 없음 — version 은 그래도 동작해야 한다.
  const r = run(base, flag, []);
  r.stdout = r.stdout.replace(/\d+\.\d+\.\d+/g, "<VER>");
  emit(nm, label, r, null, base);
}

// v091-04: next — verify FAIL(범위 밖 신규) → 원인 요약(counts + 대표 파일) + explain 추천(exit 1)
{
  const c = track(newCase());
  mkdirSync(join(c.repo, ".agent-guard"), { recursive: true });
  writeFileSync(join(c.repo, ".agent-guard", "contract.yaml"), S2_SRC); // allowed src/**
  run(c.repo, "start", []); // baseline: contract.yaml ambient
  writeFileSync(join(c.repo, "newfile.txt"), "out of scope\n"); // start 이후 신규 oos → verify FAIL
  emit("v091-04-next-verify-fail", "guard start … ; (oos) ; guard next   (verify FAIL 요약 → explain)",
    run(c.repo, "next", []), null, c.base);
}

// ───────────────────────────── 인덱스 + 정리 ─────────────────────────────

if (!CHECK) {
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
}

for (const b of bases) {
  try { rmSync(b, { recursive: true, force: true }); } catch { /* tmp 정리 best-effort */ }
}

if (CHECK) {
  if (checkFails.length) {
    console.error(`\n골든 비교 실패: ${checkFails.length}건 / ${captures.length} 케이스`);
    for (const f of checkFails.slice(0, 40)) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`\n골든 비교(--check): ${captures.length} cases 전부 PASS ✅`);
  process.exit(0);
}

console.log(`\ngolden 캡처 완료: ${captures.length} cases → test/golden/`);
for (const c of captures) console.log(`  ${c.name.padEnd(34)} exit=${c.exit}  ${c.cmdline}`);
console.log("");
