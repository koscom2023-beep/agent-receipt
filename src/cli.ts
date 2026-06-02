#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadContract, type Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { printReport, toMarkdown, buildPrompt, toJsonReport, printCheckReport } from "./output.js";
import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { runInit } from "./init.js";
import { runStart } from "./start.js";
import { runStatus } from "./status.js";
import { runReset } from "./reset.js";
import { runReceipt } from "./receipt.js";
import { runDoctor } from "./doctor.js";
import { runLint } from "./lint.js";
import { runClaims } from "./claims.js";
import { runExplain } from "./explain.js";
import { runDefault } from "./router.js";

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 값 없는 boolean 플래그(예: --json)는 존재 여부만 본다. getArg(다음 인자 반환)와 구분.
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function requireRepo(): void {
  if (!g.isGitRepo()) {
    console.error("여기는 git 저장소가 아님. 저장소 루트에서 실행하세요.");
    process.exit(2);
  }
}

function printHelp(): void {
  console.log(`
agent-receipt — AI 작업계약 검수 CLI

사용법:
  agent-receipt init   --preset <generic|nextjs-supabase|promptia>   시작용 계약 + 안내 생성(.agent-guard/)
  agent-receipt start  --contract <path.yaml>   작업 시작 baseline 기록(.agent-guard/session.json)
  agent-receipt status --contract <path.yaml>   계약/세션/git 상태 요약 (read-only)
  agent-receipt reset                           baseline(session.json) 제거
  agent-receipt verify --contract <path.yaml>   변경 diff/범위/금지/NUL 상태 검사 (실패 시 exit 1)
                                                (명령은 실행 안 함 — 테스트/빌드는 agent-receipt check)
        [--json]                                사람용 보고서 대신 기계용 stable JSON을 stdout에 단독 출력
  agent-receipt check  --contract <path.yaml>   required_checks.commands(tsc/test 등)만 실행 (git 불필요)
  agent-receipt report --contract <path.yaml>   verify + 마크다운 보고서 저장 (--out 으로 경로 지정)
  agent-receipt receipt --contract <path.yaml>  verify+check 결과를 .agent-guard/receipts/ 에 저장 [--format json|md] [--out]
  agent-receipt claims --file <claim.json>      AI 완료보고(JSON)를 git 실측과 대조 (mismatch 시 exit 1)
  agent-receipt explain --contract <path.yaml>  왜 PASS/FAIL 인지 설명 + 규모/critical 경로 (exit = verify)
  agent-receipt pre    --contract <path.yaml>   작업 시작 전 안전 점검
  agent-receipt prompt --contract <path.yaml>   Cursor/Claude에 붙여넣을 지시문 생성
  agent-receipt doctor                          환경/설정 건강 점검 (git/계약/baseline)
  agent-receipt lint   --contract <path.yaml>   계약 품질 조언 (advisory)

  agent-receipt run                             agent-receipt(인자 없음)와 동일 — 상태 기반 다음 명령 안내

  --contract 생략 시 .agent-guard/contract.yaml 등을 자동 탐색
  agent-receipt        (인자 없이 실행)         현재 상태를 보고 다음 명령을 안내(준비됐으면 verify 실행)
`);
}

function runPre(contract: Contract): void {
  const problems: string[] = [];

  const current = g.currentBranch();
  const expected = contract.branch?.expected;
  if (expected && expected !== current) {
    problems.push(`브랜치가 '${current}'. 계약은 '${expected}'에서 작업하길 기대함.`);
  }

  const staged = g.stagedFiles();
  if (staged.length) {
    problems.push(`이미 stage된 파일이 ${staged.length}개 있음. 작업 전 정리 권장.`);
  }

  console.log("");
  if (problems.length) {
    console.log("⚠️  작업 시작 전 확인할 점:");
    for (const p of problems) console.log(`   - ${p}`);
    console.log("\n정리 후 시작하세요.\n");
    process.exit(1);
  }
  console.log(`✅ 시작 OK — 브랜치 '${current}', 계약 '${contract.id}'.\n`);
}

function main(): void {
  const command = process.argv[2];

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  // 인자 없이 실행(또는 명시적 `run`) → 단일명령 라우팅(상태 기반 안내 / 준비됐으면 verify).
  // help 는 위에서 이미 가로챔. runDefault 가 계약/세션을 직접 탐색하므로 계약 해석 전에 분기한다.
  if (!command || command === "run") {
    runDefault();
  }

  // init/reset 은 계약이 필요 없는 명령이라 계약 해석 전에 분리 처리한다(기존 명령 흐름 불변).
  if (command === "init") {
    runInit(getArg("--preset"));
  }
  if (command === "reset") {
    runReset();
  }
  if (command === "doctor") {
    // 환경 점검 — 계약이 없을 수도 있으니 계약 해석 전에 처리(자체적으로 계약을 탐색).
    runDoctor();
  }

  const contractPath = getArg("--contract") ?? getArg("-c") ?? discoverContract();
  if (!contractPath) {
    console.error("계약서 경로가 필요함:  agent-receipt <command> --contract <path.yaml>");
    process.exit(2);
  }

  let contract: Contract;
  try {
    contract = loadContract(contractPath);
  } catch (e: any) {
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }

  switch (command) {
    case "verify": {
      requireRepo();
      const r = runVerify(contract);
      if (hasFlag("--json")) {
        // 기계용: stdout엔 spec 필드만 추린 stable JSON 한 줄만. 그 외 출력은 일절 금지.
        process.stdout.write(JSON.stringify(toJsonReport(r)) + "\n");
      } else {
        printReport(r, contract);
        // verify는 commands를 실행하지 않는다 — 사람이 "테스트도 통과"로 오인하지 않도록 알림(stderr).
        process.stderr.write(
          "note: verify는 상태만 검사하고 명령(commands)을 실행하지 않습니다 — 테스트/빌드 검증은 `agent-receipt check`.\n"
        );
      }
      process.exit(r.ok ? 0 : 1);
    }

    case "check": {
      // commands는 git 상태와 무관하므로 requireRepo()를 강제하지 않는다.
      const r = runCheck(contract);
      printCheckReport(r);
      process.exit(r.ok ? 0 : 1);
    }

    case "report": {
      requireRepo();
      const r = runVerify(contract);
      printReport(r);
      const out = getArg("--out") ?? `agent-guard-report-${contract.id}.md`;
      writeFileSync(out, toMarkdown(r), "utf8");
      console.log(`보고서 저장: ${out}\n`);
      process.exit(r.ok ? 0 : 1);
    }

    case "pre": {
      requireRepo();
      runPre(contract);
      break;
    }

    case "start": {
      // 작업 시작 baseline 기록. verify 동작은 바꾸지 않는다(baseline 적용은 별도 단계).
      requireRepo();
      runStart(contract);
      break;
    }

    case "status": {
      // 계약/세션/git 상태 요약(read-only).
      requireRepo();
      runStatus(contract);
      break;
    }

    case "receipt": {
      // verify + check 결과를 .agent-guard/receipts/ 에 저장(AI Work Receipt).
      requireRepo();
      runReceipt(contract, getArg("--format"), getArg("--out"));
      break;
    }

    case "claims": {
      // AI 완료보고(JSON)를 git 실측과 대조 — git 필요(runVerify/runCheck 사용).
      requireRepo();
      runClaims(contract, getArg("--file"));
      break;
    }

    case "explain": {
      // 왜 PASS/FAIL 인지 설명(+규모/critical) — exit 는 verify 와 동일.
      requireRepo();
      runExplain(contract);
      break;
    }

    case "lint": {
      // 계약 품질 조언(advisory) — git 불필요.
      runLint(contract);
      break;
    }

    case "prompt": {
      console.log("\n" + buildPrompt(contract) + "\n");
      break;
    }

    default:
      console.error(`모르는 명령: ${command}`);
      printHelp();
      process.exit(2);
  }
}

main();
