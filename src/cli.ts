#!/usr/bin/env node
import { loadContract, type Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { printReport, buildPrompt, toJsonReport, printCheckReport, type PromptVariant } from "./output.js";
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
import { runMode } from "./mode.js";
import { runReceipts, type ReceiptsMode } from "./receipts.js";
import { runPresets } from "./presets.js";
import { runDraftContract } from "./draft.js";
import { runReview } from "./review.js";
import { runAudit } from "./audit.js";
import { runDashboard } from "./dashboard.js";
import { runApprove, runApprovals } from "./approve.js";
import { runExport } from "./export.js";
import { runKeysInit, runSign, runVerifySignature } from "./keys.js";
import { runPolicy } from "./policy.js";
import { runBegin } from "./begin.js";
import { runDone } from "./done.js";
import { runCommitCheck, runTrailer } from "./commitcheck.js";
import { runAuditPack } from "./auditpack.js";
import { runLedger, runLedgerRebuild } from "./ledger.js";
import { runReplay } from "./replay.js";
import { runAttest } from "./attest.js";
import { runIncident } from "./incident.js";
import { runReport } from "./report.js";

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

// 짧은 help — 일상 흐름 5개 + explain + help --all. 초보자 진입장벽 최소화.
function printHelp(): void {
  console.log(`
agent-receipt — AI 작업 감사 영수증 (git 작업트리 기준)

자주 쓰는 흐름:
  agent-receipt begin  [--cursor|--claude]   작업 시작: policy 확인 + baseline + 지시문 출력
  agent-receipt done   [--claim <c.json>] [--client]   작업 종료: verify+check+receipt 저장 + 요약
  agent-receipt commit-check                 커밋 직전 확인(자동 commit 안 함) + 트레일러 출력
  agent-receipt audit-pack [--claim <c.json>] [--redact]   증거 묶음 생성(감사 검토용)
  agent-receipt explain                      왜 PASS/FAIL 인지 + 이 도구가 못 보는 것

  전체 명령:  agent-receipt help --all
  이 도구는 git 작업트리 기준입니다 — .gitignore·레포 밖·OS·DB·외부 서비스는 못 봅니다("컴플라이언스 보장" 아님).
`);
}

function printHelpAll(): void {
  console.log(`
agent-receipt — AI 작업계약 검수 / 작업 감사 CLI (전체 명령)

계약/세션:
  presets / init --preset <name> / draft-contract / review / start / status / mode / reset
정책(상시 규칙):
  policy init [--profile solo-founder|vibe-coder|agency-client|team-strict|promptia] / policy check / policy show
검증:
  verify [--json] / check / explain / claims --file <c.json> / pre / prompt [--cursor|--claude]
감사 흐름(요약):
  begin [--cursor|--claude] / done [--claim <c.json>] [--client] [--ledger] / commit-check / trailer
증빙/감사 묶음:
  report [--type developer|client|audit] [--out] / receipt [--format json|md|client-md] [--redact] [--out]
  receipts [--latest|--cat|--dir] / audit [--json] / dashboard [--out]
  audit-pack [--out <dir>] [--claim <c.json>] [--redact] [--ledger]
  ledger [--json] / ledger rebuild
  replay --pack <dir>  (별칭 verify-pack) / attest --receipt <p> | --pack <dir>
  incident [--since <n>]
서명/승인:
  keys init / sign --receipt <p> / verify-signature --receipt <p> / approve --receipt <p> [--note] / approvals
연동(미리보기 — 전송 없음):
  export --format <slack|json|github-pr|otel|langfuse> --receipt <p>
점검/기타:
  doctor / lint / run

  --contract 생략 시 .agent-guard/contract.yaml 등을 자동 탐색
  한계: git 작업트리 기준 — .gitignore·레포 밖·OS·DB·외부 서비스는 직접 못 봅니다. "컴플라이언스 보장"이 아니라 "git 증거 제공".
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
    if (hasFlag("--all")) printHelpAll();
    else printHelp();
    process.exit(0);
  }

  // 인자 없이 실행(또는 명시적 `run`) → 단일명령 라우팅(상태 기반 안내 / 준비됐으면 verify).
  if (!command || command === "run") {
    runDefault();
  }

  // 계약/git 불필요한 명령 — 계약 해석 전에 분리 처리(기존 명령 흐름 불변).
  if (command === "init") {
    runInit(getArg("--preset"));
  }
  if (command === "reset") {
    runReset();
  }
  if (command === "doctor") {
    runDoctor();
  }
  if (command === "mode") {
    runMode();
  }
  if (command === "policy") {
    runPolicy(process.argv[3], getArg("--profile"));
  }
  if (command === "ledger") {
    if (process.argv[3] === "rebuild") runLedgerRebuild();
    runLedger(hasFlag("--json"));
  }
  if (command === "replay" || command === "verify-pack") {
    runReplay(getArg("--pack"));
  }
  if (command === "attest") {
    runAttest(getArg("--receipt"), getArg("--pack"));
  }
  if (command === "incident") {
    runIncident(getArg("--since"));
  }
  if (command === "receipts") {
    const sub: ReceiptsMode = hasFlag("--latest")
      ? "latest"
      : hasFlag("--cat")
        ? "cat"
        : hasFlag("--dir")
          ? "dir"
          : "list";
    runReceipts(sub);
  }
  if (command === "presets") {
    runPresets();
  }
  if (command === "draft-contract") {
    runDraftContract(getArg("--preset"), getArg("--out"), hasFlag("--print"));
  }
  if (command === "audit") {
    runAudit(hasFlag("--json"));
  }
  if (command === "dashboard") {
    runDashboard(getArg("--out"));
  }
  if (command === "approve") {
    runApprove(getArg("--receipt"), getArg("--note"));
  }
  if (command === "approvals") {
    runApprovals();
  }
  if (command === "export") {
    runExport(getArg("--format"), getArg("--receipt"));
  }
  if (command === "keys") {
    if (process.argv[3] === "init") runKeysInit();
    console.error("사용: agent-receipt keys init");
    process.exit(2);
  }
  if (command === "sign") {
    runSign(getArg("--receipt"));
  }
  if (command === "verify-signature") {
    runVerifySignature(getArg("--receipt"));
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

  const promptVariant: PromptVariant = hasFlag("--cursor") ? "cursor" : hasFlag("--claude") ? "claude" : "generic";

  switch (command) {
    case "verify": {
      requireRepo();
      const r = runVerify(contract);
      if (hasFlag("--json")) {
        // 기계용: stdout엔 spec 필드만 추린 stable JSON 한 줄만. 그 외 출력은 일절 금지.
        process.stdout.write(JSON.stringify(toJsonReport(r)) + "\n");
      } else {
        printReport(r, contract);
        process.stderr.write(
          "note: verify는 상태만 검사하고 명령(commands)을 실행하지 않습니다 — 테스트/빌드 검증은 `agent-receipt check`.\n"
        );
      }
      process.exit(r.ok ? 0 : 1);
    }

    case "check": {
      const r = runCheck(contract);
      printCheckReport(r);
      process.exit(r.ok ? 0 : 1);
    }

    case "report": {
      requireRepo();
      runReport(contract, contractPath, getArg("--type"), getArg("--out"));
      break;
    }

    case "pre": {
      requireRepo();
      runPre(contract);
      break;
    }

    case "start": {
      requireRepo();
      runStart(contract);
      break;
    }

    case "status": {
      requireRepo();
      runStatus(contract);
      break;
    }

    case "begin": {
      requireRepo();
      runBegin(contract, promptVariant);
      break;
    }

    case "done": {
      requireRepo();
      runDone(contract, contractPath, getArg("--claim"), hasFlag("--client"), hasFlag("--ledger"));
      break;
    }

    case "commit-check": {
      requireRepo();
      runCommitCheck(contract, contractPath);
      break;
    }

    case "trailer": {
      requireRepo();
      runTrailer(contract, contractPath);
      break;
    }

    case "audit-pack": {
      requireRepo();
      runAuditPack(contract, contractPath, getArg("--out"), getArg("--claim"), hasFlag("--redact"), hasFlag("--ledger"));
      break;
    }

    case "receipt": {
      requireRepo();
      runReceipt(contract, contractPath, getArg("--format"), getArg("--out"), hasFlag("--redact"));
      break;
    }

    case "claims": {
      requireRepo();
      runClaims(contract, getArg("--file"));
      break;
    }

    case "explain": {
      requireRepo();
      runExplain(contract);
      break;
    }

    case "lint": {
      runLint(contract);
      break;
    }

    case "review": {
      runReview(contract);
      break;
    }

    case "prompt": {
      console.log("\n" + buildPrompt(contract, promptVariant) + "\n");
      break;
    }

    default:
      console.error(`모르는 명령: ${command}`);
      printHelp();
      process.exit(2);
  }
}

main();
