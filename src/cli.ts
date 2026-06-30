#!/usr/bin/env node
import { loadContract, type Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { printReport, buildPrompt, toJsonReport, printCheckReport, type PromptVariant } from "./output.js";
import * as g from "./git.js";
import { discoverContract } from "./discover.js";
import { runInit } from "./init.js";
import { runStart, SESSION_KINDS, type SessionKind } from "./start.js";
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
import { runCloseRecon } from "./closerecon.js";
import { runPrepareCommit } from "./preparecommit.js";
import { runFinish } from "./finish.js";
import { runLedger, runLedgerRebuild, runLedgerVerify } from "./ledger.js";
import { runReplay } from "./replay.js";
import { runAttest } from "./attest.js";
import { runControls } from "./controls.js";
import { runInsights } from "./insights.js";
import { runRisk } from "./risk.js";
import { runAnchor, runAnchorUpload } from "./anchor.js";
import { runIncident } from "./incident.js";
import { runReport } from "./report.js";
import { runNote } from "./note.js";
import { runReleaseCheck } from "./releasecheck.js";
import { runNext } from "./nextcmd.js";
import { installedVersion } from "./version.js";
import { runInstallHooks, runUninstallHooks } from "./hooks.js";
import { runSelftest } from "./selftest.js";
import { runIndex } from "./receiptindex.js";
import { runGenClaim } from "./genclaim.js";
import { runCaptureIngest, runCaptureShow, runCaptureReset, runCaptureInstall, runCaptureUninstall, runCaptureVerify } from "./capture.js";
import { runShareProof, runShareProofFromSaved, latestReceiptExists } from "./shareproof.js";

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 값 없는 boolean 플래그(예: --json)는 존재 여부만 본다. getArg(다음 인자 반환)와 구분.
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

// 반복 가능한 플래그 모으기(예: --observe a --observe b). release-check 의 postDeployObserve 용.
function getAllArgs(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1] as string);
  }
  return out;
}

// --kind <value> 파싱+검증(begin/start). 미지정→undefined. 알 수 없는 값→exit 2.
function getKind(): SessionKind | undefined {
  const v = getArg("--kind");
  if (v === undefined) return undefined;
  if (!(SESSION_KINDS as readonly string[]).includes(v)) {
    console.error(`알 수 없는 --kind: ${v} — 사용 가능: ${SESSION_KINDS.join(", ")}`);
    process.exit(2);
  }
  return v as SessionKind;
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
agent-receipt — AI 작업 감사 영수증 (git 작업트리 기준 — git 만 증거)

핵심 흐름 (이 셋이면 충분):
  agent-receipt begin [--cursor|--claude] [--kind ...]   작업 시작(baseline + 지시문)
  agent-receipt done                                     작업 종료(verify+check+receipt 저장)
  agent-receipt share-proof                              클라이언트 전달용 증거 HTML 생성

  왜 PASS/FAIL 인지 + 이 도구가 못 보는 것:   agent-receipt explain
  전체 명령(세션·정찰·증빙·정책·연동 등):     agent-receipt help --all
  git 만 증거입니다 — self-report·메모(note)·release 판단은 참고(advisory)이며 PASS/FAIL 근거가 아닙니다.
  한계: .gitignore·레포 밖·OS·DB·외부 서비스는 못 봅니다("컴플라이언스 보장" 아님).
`);
}

function printHelpAll(): void {
  console.log(`
agent-receipt — 전체 명령 (git 작업트리 기준 — git 만 증거)

■ 핵심 루프(대부분 이 6개면 충분):
  begin [--cursor|--claude] [--kind <recon|implementation|docs|test|measure-first|observe-only|release-check>]
  done / share-proof [--receipt <p>] [--out <p>] / next / audit-pack / prepare-commit [--message <m>] [--include-linked-tests] / explain

■ 세션 / 정찰 / 구현:
  start / status / mode / reset / close-recon / finish [--message <m>] [--client] / trailer / commit-check / receipt

■ 계약 관리:
  presets / init --preset <name> / draft-contract / review / lint / doctor

■ 설치 / 자가검증:
  install-hooks [--force] / uninstall-hooks   git pre-commit·pre-push 게이트 설치/제거(기존 hook 보존, 우회 --no-verify)
  selftest                                     임시 repo 로 PASS/FAIL·차단·우회 자가검증(설치/PATH 신뢰 확인)

■ 검증(git 실측):
  verify [--json] / check / claims --file <c.json> / pre / prompt [--cursor|--claude]

■ 증빙 / 감사 묶음(git 증거):
  report [--type developer|client|audit] / receipt [--format ...] [--content] [--strict-redact] [--agent <n>] [--model <m>] / receipts [--latest|--cat|--dir]
  audit [--json] / insights [--since <n>] [--format md|json] / risk [--format md|json] / dashboard / index [--json] / ledger [--json] (rebuild|verify) / replay --pack <dir> / attest / anchor [--upload] / controls [--format md|json] / incident

■ 서명 / 승인(로컬·ed25519):
  keys init / sign --receipt <p> / verify-signature --receipt <p> / approve --receipt <p> [--note <t>] / approvals

■ 정책(상시 규칙):
  policy init [--profile solo-founder|vibe-coder|agency-client|team-strict|promptia] / policy check / policy show

■ advisory / 참고 (검증 아님 — PASS/FAIL 근거 아님):
  release-check --base <ref> [--failed-tests <f>] [--observe <ev>]   배포 판단 보조(deploy/push 안 함)
  note --type <recon|contract-draft|no-code-decision|next-options>   사람이 남긴 메모/판단(git 검증 아님)
  policy mode measure_first|observe_only                            self-report 체크리스트(강제 아님)
  claim modeClaims / externalActions                                self-report(git 검증 불가)

■ 연동(experimental — 미리보기, 전송 없음):
  export --format <slack|json|github-pr|otel|langfuse> --receipt <p>
  gen-claim --transcript <jsonl> [--out <claim.json>]   에이전트 transcript → claim.json(이후 claims 로 대조)
  capture [--event pre|post] / show [--json] / verify / reset / install [--write] [--global] / uninstall   git 너머 행위 추적(훅 stdin·값 미저장·체인 검증·alpha)

■ 기타: run

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

  // 버전 — 계약/git 불필요, help·unknown 처리보다 먼저. --version / -v / version 동일 출력. exit 0.
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(installedVersion());
    process.exit(0);
  }

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
  if (command === "install-hooks") {
    runInstallHooks(hasFlag("--force"));
  }
  if (command === "uninstall-hooks") {
    runUninstallHooks();
  }
  if (command === "selftest") {
    runSelftest();
  }
  if (command === "policy") {
    runPolicy(process.argv[3], getArg("--profile"));
  }
  if (command === "ledger") {
    if (process.argv[3] === "rebuild") runLedgerRebuild();
    if (process.argv[3] === "verify") runLedgerVerify();
    runLedger(hasFlag("--json"));
  }
  if (command === "replay" || command === "verify-pack") {
    runReplay(getArg("--pack"));
  }
  if (command === "attest") {
    runAttest(getArg("--receipt"), getArg("--pack"));
  }
  if (command === "controls") {
    runControls(getArg("--receipt"), getArg("--format"), hasFlag("--redact"));
  }
  if (command === "insights") {
    runInsights(getArg("--since"), getArg("--format"));
  }
  if (command === "risk") {
    runRisk(getArg("--receipt"), getArg("--format"));
  }
  if (command === "incident") {
    runIncident(getArg("--since"));
  }
  if (command === "note") {
    requireRepo();
    runNote(getArg("--type"), getArg("--message"));
  }
  if (command === "release-check") {
    requireRepo();
    runReleaseCheck(getArg("--base"), getArg("--failed-tests"), getAllArgs("--observe"));
  }
  if (command === "next") {
    runNext();
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
  if (command === "index") {
    runIndex(hasFlag("--json"));
  }
  if (command === "gen-claim") {
    runGenClaim(getArg("--transcript"), getArg("--out"));
  }
  // capture (alpha) — 훅 stdin 행위 기록 / 집계 / 초기화. hook 호출용(기본 help 미노출).
  if (command === "capture") {
    const sub = process.argv[3];
    if (sub === "show") runCaptureShow(hasFlag("--json"));
    if (sub === "verify") runCaptureVerify();
    if (sub === "reset") runCaptureReset();
    if (sub === "install") runCaptureInstall(hasFlag("--write"), hasFlag("--global"));
    if (sub === "uninstall") runCaptureUninstall(hasFlag("--write"), hasFlag("--global"));
    runCaptureIngest(getArg("--event"));
  }
  // share-proof: --receipt 또는 저장된 receipt 가 있으면 그걸 렌더(계약 불필요·done 시점 그대로).
  // 둘 다 없으면 아래 switch 에서 현재 상태로 fresh build(계약 필요).
  if (command === "share-proof") {
    const rp = getArg("--receipt");
    if (rp || latestReceiptExists()) runShareProofFromSaved(rp, getArg("--out"), hasFlag("--redact"));
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
  if (command === "anchor") {
    if (hasFlag("--upload")) {
      runAnchorUpload(getArg("--receipt"));
      return;
    }
    runAnchor(getArg("--receipt"));
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
      runStart(contract, getKind());
      break;
    }

    case "status": {
      requireRepo();
      runStatus(contract);
      break;
    }

    case "begin": {
      requireRepo();
      runBegin(contract, promptVariant, getKind());
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

    case "close-recon": {
      requireRepo();
      runCloseRecon(contract, contractPath);
      break;
    }

    case "prepare-commit": {
      requireRepo();
      runPrepareCommit(contract, contractPath, getArg("--message"), hasFlag("--include-linked-tests"));
      break;
    }

    case "finish": {
      requireRepo();
      runFinish(contract, contractPath, getArg("--message"), hasFlag("--client"));
      break;
    }

    case "receipt": {
      requireRepo();
      runReceipt(contract, contractPath, getArg("--format"), getArg("--out"), hasFlag("--redact"), {
        content: hasFlag("--content"),
        strictRedact: hasFlag("--strict-redact"),
        agent: getArg("--agent"),
        model: getArg("--model"),
      });
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

    case "share-proof": {
      requireRepo();
      runShareProof(contract, contractPath, getArg("--out"), hasFlag("--redact"));
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
