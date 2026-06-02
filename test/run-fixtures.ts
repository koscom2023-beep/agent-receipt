// agent-guard v0.1 fixture 러너 (프레임워크 없음 — node + tsx 만 사용)
//
// 실행: npx tsx test/run-fixtures.ts   (또는 node_modules/.bin/tsx test/run-fixtures.ts)
//
// 설계(14인 회의 합의):
//  - 각 fixture는 OS tmpdir에 격리된 git repo를 새로 만든다(전역상태 오염 0).
//  - 실제 CLI를 서브프로세스로 띄워 exit code + stdout JSON 계약을 통합 검증한다
//    (in-process + process.chdir 는 전역 cwd 오염 위험이 있어 배제).
//  - tsx 는 node_modules/.bin 의 절대경로로만 호출(npx 네트워크/ PATH 위험 회피).
//  - 서브프로세스 env 는 화이트리스트(PATH/HOME) + GIT_* 격리(호스트 git config 무의존).
//  - 계약 YAML 은 repo *밖*(case 디렉터리)에 두어 repo 의 git 상태를 오염시키지 않는다.
//  - 에러=FAIL: 예외/파싱실패/exit 불일치는 전부 실패로 집계하고, 절대 통과로 묻지 않는다.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");

// tsx 미설치 = 환경설정 실패. 코드 회귀와 구분되는 메시지로 즉시 중단(거짓 초록 방지).
if (!existsSync(tsxBin)) {
  console.error(`ENV ERROR: tsx 를 찾을 수 없음 (${tsxBin}). 먼저 'npm install' 하세요.`);
  process.exit(1);
}

// 서브프로세스/ git 공용 환경 — 호스트 git config·GIT_* 를 차단해 결과를 결정론화.
const ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

// git 실행(아이덴티티/서명 인라인 주입 — 전역 config 비의존)
function git(cwd: string, args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=ci@local", "-c", "user.name=ci", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: ENV, stdio: ["ignore", "ignore", "ignore"] }
  );
}

// case 디렉터리: { base/contract.yaml, base/repo/ }. 계약은 repo 밖이라 git 상태에 안 잡힌다.
// 기본 브랜치는 main 고정(git 버전 무관: symbolic-ref) + base 커밋 1개.
function newCase(): { repo: string; contract: string } {
  const base = mkdtempSync(join(tmpdir(), "ag-fix-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(repo, "f.txt"), "base content\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return { repo, contract: join(base, "contract.yaml") };
}

type VerifyRun = { status: number | null; json: any; stdout: string; stderr: string };

function verifyJson(repo: string, contract: string): VerifyRun {
  const res = spawnSync(tsxBin, [cli, "verify", "--json", "--contract", contract], {
    cwd: repo,
    env: ENV,
    encoding: "utf8",
  });
  if (res.error) throw new Error(`서브프로세스 spawn 실패: ${res.error.message}`);
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new Error(`stdout 이 유효한 JSON 단독이 아님. stdout=${JSON.stringify(res.stdout)} stderr=${res.stderr}`);
  }
  return { status: res.status, json, stdout: res.stdout, stderr: res.stderr };
}

// --json 출력의 stable 키 집합(spec 필드만, 순서 무관 비교용)
const SPEC_KEYS = [
  "ok", "contractId", "title", "branch", "touched", "staged", "untracked",
  "outOfScope", "deniedHits", "stagedOutOfScope", "nulBad", "violations",
  "headHash", "aheadBehind",
].sort();

const FIXTURES: Array<{ name: string; run: () => void }> = [
  {
    // ① 허용 범위 안 변경 → PASS. + --json stable 스키마(키셋/제외필드/null 정규화) 단언.
    name: "allowed → PASS (+ json keyset/null)",
    run: () => {
      const { repo, contract } = newCase();
      writeFileSync(contract, `id: fix-allowed-pass\nscope:\n  allowed_paths:\n    - "f.txt"\n`);
      writeFileSync(join(repo, "f.txt"), "edited within allowed scope\n");
      const { status, json, stdout, stderr } = verifyJson(repo, contract);
      assert.equal(status, 0, "허용 범위 안 변경은 exit 0 이어야 함");
      assert.equal(json.ok, true);
      assert.deepEqual(json.violations, []);
      // Q6 계약 봉인: --json 시 stdout=JSON 한 줄 단독, stderr로 verify note 누출 금지
      assert.equal(stdout.trim().split("\n").length, 1, "--json stdout 은 JSON 한 줄이어야 함");
      assert.ok(!stderr.includes("note:"), "--json 모드에선 verify note 가 stderr 로도 새지 않아야 함");
      // stable 스키마: 키 집합이 spec 14개와 정확히 일치
      assert.deepEqual(Object.keys(json).sort(), SPEC_KEYS, "최상위 키셋이 spec 과 불일치");
      assert.deepEqual(Object.keys(json.branch).sort(), ["current", "expected", "ok"].sort());
      // 제외 필드는 출력되지 않아야 함
      assert.ok(!("commands" in json), "commands 는 제외되어야 함");
      assert.ok(!("nulPaths" in json), "nulPaths 는 제외되어야 함");
      assert.ok(!("changed" in json), "changed 는 존재하지 않아야 함");
      // null 정규화: title/branch.expected 부재 시 키는 유지되고 값은 null
      assert.equal(json.title, null, "title 부재 → null");
      assert.equal(json.branch.expected, null, "branch.expected 부재 → null");
      // aheadBehind: origin/main 부재 → 키는 존재, 값은 null
      assert.ok("aheadBehind" in json, "aheadBehind 키는 항상 존재");
      assert.equal(json.aheadBehind, null, "upstream 부재 → aheadBehind null");
    },
  },
  {
    // ② 금지 경로 변경 → FAIL. + title/branch.expected 가 있을 때 값이 그대로 실리는지 단언.
    name: "denied → FAIL (+ json present-values)",
    run: () => {
      const { repo, contract } = newCase();
      writeFileSync(join(repo, "secret.txt"), "secret base\n");
      git(repo, ["add", "secret.txt"]);
      git(repo, ["commit", "-q", "-m", "add secret"]);
      writeFileSync(
        contract,
        `id: fix-denied-fail\ntitle: denied test\nbranch:\n  expected: main\nscope:\n  allowed_paths:\n    - "**"\n  denied_paths:\n    - "secret.txt"\n`
      );
      writeFileSync(join(repo, "secret.txt"), "secret MODIFIED\n");
      const { status, json } = verifyJson(repo, contract);
      assert.equal(status, 1, "금지 경로 변경은 exit 1");
      assert.equal(json.ok, false);
      assert.ok(json.deniedHits.includes("secret.txt"), "deniedHits 에 secret.txt 포함");
      assert.ok(json.violations.length > 0);
      // present-value: 옵셔널 필드가 있을 때 그대로 실림(null 로 덮어쓰지 않음)
      assert.equal(json.title, "denied test");
      assert.equal(json.branch.expected, "main");
      assert.equal(json.branch.ok, true, "현재 브랜치 main == expected main");
    },
  },
  {
    // ③ 허용 범위 밖 파일이 stage 됨 → FAIL (stagedOutOfScope 유발).
    name: "staged out-of-scope → FAIL",
    run: () => {
      const { repo, contract } = newCase();
      writeFileSync(
        contract,
        `id: fix-staged-oos\nscope:\n  allowed_paths:\n    - "f.txt"\ngit:\n  require_only_allowed_files_staged: true\n`
      );
      writeFileSync(join(repo, "g.txt"), "out of scope staged\n");
      git(repo, ["add", "g.txt"]);
      const { status, json } = verifyJson(repo, contract);
      assert.equal(status, 1);
      assert.equal(json.ok, false);
      assert.ok(json.stagedOutOfScope.includes("g.txt"), "stagedOutOfScope 에 g.txt 포함");
    },
  },
  {
    // ④ 정리 안 된 새 파일(untracked) → FAIL.
    name: "untracked → FAIL",
    run: () => {
      const { repo, contract } = newCase();
      writeFileSync(
        contract,
        `id: fix-untracked\nscope:\n  allowed_paths:\n    - "**"\ngit:\n  require_no_staged_untracked: true\n`
      );
      writeFileSync(join(repo, "u.txt"), "untracked file\n");
      const { status, json } = verifyJson(repo, contract);
      assert.equal(status, 1);
      assert.equal(json.ok, false);
      assert.ok(json.untracked.includes("u.txt"), "untracked 에 u.txt 포함");
    },
  },
  {
    // ⑤ NUL 바이트(파일 깨짐) → FAIL.
    name: "NUL byte → FAIL",
    run: () => {
      const { repo, contract } = newCase();
      writeFileSync(
        contract,
        `id: fix-nul\nscope:\n  allowed_paths:\n    - "**"\nrequired_checks:\n  nul:\n    paths:\n      - "bin.dat"\n`
      );
      writeFileSync(join(repo, "bin.dat"), Buffer.from([0x41, 0x00, 0x42])); // 'A' NUL 'B'
      const { status, json } = verifyJson(repo, contract);
      assert.equal(status, 1);
      assert.equal(json.ok, false);
      assert.ok(json.nulBad.includes("bin.dat"), "nulBad 에 bin.dat 포함");
    },
  },
];

let failures = 0;
console.log(`\nagent-guard fixtures (${FIXTURES.length})\n`);
for (const f of FIXTURES) {
  try {
    f.run();
    console.log(`  ✓ ${f.name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${f.name}\n      ${(e as Error).message}`);
  }
}
if (failures) {
  console.error(`\n${failures}/${FIXTURES.length} fixture FAILED\n`);
  process.exit(1);
}
console.log(`\nAll ${FIXTURES.length} fixtures PASSED\n`);
