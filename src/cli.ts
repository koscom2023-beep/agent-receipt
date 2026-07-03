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
import { runCost } from "./cost.js";
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
import { runCaptureIngest, runCaptureShow, runCaptureReset, runCaptureInstall, runCaptureUninstall, runCaptureVerify, runCaptureInstallCursor } from "./capture.js";
import { runShareProof, runShareProofFromSaved, latestReceiptExists } from "./shareproof.js";
import { runResearchVerify } from "./research.js";
import { runCouncilVerify } from "./council.js";
import { runSpec } from "./spec.js";
import { runBadge } from "./badge.js";
import { runReplayReceipt } from "./vreceipt.js";
import { runGraphQuery, runGraphView, runGraphFailures, runGraphDiff, runGraphHistory, runGraphSubjects } from "./graph.js";

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
  install-hooks [--force] / uninstall-hooks   pre-commit·pre-push 게이트 + post-commit 증거(receipt --committed·--no-verify 우회에도 남음) 설치/제거(기존 hook 보존)
  selftest                                     임시 repo 로 PASS/FAIL·차단·우회 자가검증(설치/PATH 신뢰 확인)

■ 검증(git 실측):
  verify [--json] / check / claims --file <c.json> / pre / prompt [--cursor|--claude]

■ 리서치 근거검증(출처 대조 — git 아님·검증만·공유 Evidence Kernel):
  research verify --file <report.json|report.md> [--fetch] [--out <p>]   각 주장의 14종 근거(인용·수치·날짜·링크·해시·서명·commit·변경파일·diff·스키마·버전·파일·영수증·산출물)를 결정론 대조 · .md=동결 문법 입력 · --fetch=라이브 재대조 · --out=Verification Receipt(입력해시+provenance 봉인)

■ 회의 결정검증(결정↔근거 대조 — 회의 실행 아님·검증만·같은 Evidence Kernel):
  council verify --file <decision.json> [--log <path>] [--out <p>]   결정의 근거(인용·수치·날짜·링크·해시·서명)를 대조 · --log=append-only DecisionLog · --out=Verification Receipt

■ Evidence Specification(검증 포맷의 표준 표면):
  spec [--format json]   claim/check 표준 포맷을 사람요약/기계판독(JSON Schema draft-07)으로 방출 · check kinds·상태·보증범위

■ Evidence Graph / Evidence Browser(쌓인 Verification Receipt 활용 — 읽기전용·중립 · edge 는 graph view --format json 에 실재):
  graph query --dir <d> [--commit|--input|--model|--receipt-id] [--format json]   receipt 필터 + pass/fail 중립 카운트(edge 없음)
  graph view --dir <d> [--out <html>] [--format json] [--base-dir <이전스냅샷>] [--match statement|fingerprint]   HTML=Evidence Browser(--base-dir 주면 base 대비 신규 실패에 '신규' 배지+카운트)(Failure-first: Dashboard→Failures 탭[Check별/Model별/Subject별/Commit별/Reason별]→Reason·Evidence→Affected Claim→Receipt 맨끝 drill-down) / json=소비자 API(summary·indexes·graph{nodes:Receipt/Claim/Check·edges:asserts/checked_by/same_input/same_commit/reverifies·id+basis[기계 enum]+note+tier[verified=재해시/직접읽음 확인만·나머지 reported]}·failures·receipts · 같은[입력·버전·verdict] 재검증은 한 노드로 접힘[occurrences 보존])
  graph failures --dir <d> [--by check|reason|subject|model|commit] [--check <k>] [--status s1,s2] [--subject|--model|--commit|--input <v>] [--sealed] [--since <ISO>] [--limit N] [--format json]   실패 triage(읽기전용·M건 중 N건 항상 표기·verifiedAt/commit=자가보고·--sealed=봉인 확인분만)
  graph diff (--base-dir <d1> --head-dir <d2> | --dir <d> --base-commit <c1> --head-commit <c2>) [--match statement|fingerprint] [--sealed] [--format json]   회귀 비교: 신규/해소/상태변화/입력 verdict 변화 · 신규>0=exit 1(CI 게이트) · 매칭=기록 텍스트(어느 모드든 의미 동일성 아님)·해소=고침의 증명 아님
  graph history --dir <d> (--claim <cfp1:…|접두> | --input <sha256> | --subject <s>) [--format json]   같은 주장/입력/주제의 시간축 이력(첫 등장→재검증 체인·인접 대비 새실패/해소/상태/증거 변화·관련 edge) · fingerprint=cfp1(텍스트 기반 v1·graph view json/failures 에 노출)
  graph subjects --dir <d> [--format json]   subject(프로젝트) 단위 상태판 — 순수 카운트 롤업(영수증·pass/fail·실패 이벤트·check 분포·기간[자가보고]·판단 아님) · 증감은 graph diff 의 bySubject

■ 증빙 / 감사 묶음(git 증거):
  report [--type developer|client|audit] / receipt [--format ...] [--content] [--strict-redact] [--committed] [--agent <n>] [--model <m>] / receipts [--latest|--cat|--dir]
  audit [--json] / insights [--since <n>] [--format md|json] / risk [--format md|json] / cost [--format md|json] / dashboard / index [--json] / ledger [--json] (rebuild|verify) / replay [--pack <dir>] [--receipt <p> [--fetch]] / attest / anchor [--upload] / controls [--format md|json] / incident

■ 서명 / 승인(로컬·ed25519):
  keys init / sign --receipt <p> / verify-signature --receipt <p> / approve --receipt <p> [--note <t>] / approvals / badge --receipt <p>   Rekor 앵커 영수증용 README 배지(클릭=공개 로그 검증·앵커 없으면 발급 거부)

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
  capture [--event pre|post|fail] / show [--json] / verify / reset / install [--write] [--global] / install-cursor [--write] / uninstall   git 너머 행위 추적(훅 stdin·값 미저장·체인 검증·alpha)

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
    // --receipt=Verification Receipt 재검증(무결성·재현성) / --pack=audit-pack 재검증.
    if (getArg("--receipt")) { void runReplayReceipt(getArg("--receipt"), { fetch: hasFlag("--fetch") }); return; }
    runReplay(getArg("--pack"));
  }
  if (command === "badge") {
    // 공개 로그(Rekor)로 점프하는 배지 스니펫 — 앵커 실재할 때만(장식 배지 거부).
    runBadge(getArg("--receipt"));
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
  if (command === "cost") {
    runCost(getArg("--format"), getArg("--session"));
  }
  if (command === "research") {
    // research 는 git 불필요 — ResearchReport JSON 의 인용/수치를 출처와 결정론 대조. --fetch=라이브 URL 재대조(네트워크).
    if (process.argv[3] === "verify") {
      void runResearchVerify(getArg("--file"), { fetch: hasFlag("--fetch"), out: getArg("--out") });
      return;
    }
    console.error("research: 사용법 — research verify --file <report.json> [--fetch] [--out <path>]");
    process.exit(2);
  }
  if (command === "council") {
    // council 은 회의를 실행하지 않는다(=소비자 컴파일러의 일). DecisionRecord 의 결정↔근거를 검증만.
    if (process.argv[3] === "verify") runCouncilVerify(getArg("--file"), getArg("--log"), getArg("--out"));
    console.error("council: 사용법 — council verify --file <decision.json> [--log <path>] [--out <path>]");
    process.exit(2);
  }
  if (command === "spec") {
    // Evidence Specification 방출 — 검증 포맷의 표준 표면(사람요약/기계판독 JSON Schema).
    runSpec(getArg("--format"));
  }
  if (command === "graph") {
    // Evidence Graph — 쌓인 Verification Receipt 조회(query·읽기전용) / 정적 HTML 뷰어(view·서버 0).
    const filt = { commit: getArg("--commit"), input: getArg("--input"), model: getArg("--model"), receiptId: getArg("--receipt-id") };
    if (process.argv[3] === "query") runGraphQuery(getArg("--dir"), filt, getArg("--format"));
    if (process.argv[3] === "view") runGraphView(getArg("--dir"), getArg("--out"), getArg("--format"), { baseDir: getArg("--base-dir"), match: getArg("--match") });
    if (process.argv[3] === "failures")
      // 실패 triage(읽기전용·질의) — verifiedAt/commit 은 자가보고 라벨·limit 은 M중N 항상 표기.
      runGraphFailures(
        getArg("--dir"),
        {
          check: getArg("--check"), status: getArg("--status")?.split(","), subject: getArg("--subject"),
          model: getArg("--model"), commit: getArg("--commit"), input: getArg("--input"),
          sealed: hasFlag("--sealed"), since: getArg("--since"),
        },
        getArg("--by"), getArg("--limit"), getArg("--format"),
      );
    if (process.argv[3] === "diff")
      // 회귀 비교(base→head) — 신규 실패>0 이면 exit 1(CI 게이트로 사용 가능).
      runGraphDiff({
        dir: getArg("--dir"), baseDir: getArg("--base-dir"), headDir: getArg("--head-dir"),
        baseCommit: getArg("--base-commit"), headCommit: getArg("--head-commit"),
        sealed: hasFlag("--sealed"), match: getArg("--match"), format: getArg("--format"),
      });
    if (process.argv[3] === "history")
      // 같은 주장(fingerprint)/입력(sha)/주제(subject)의 시간축 이력 — 읽기전용 질의.
      runGraphHistory(getArg("--dir"), { claim: getArg("--claim"), input: getArg("--input"), subject: getArg("--subject") }, getArg("--format"));
    if (process.argv[3] === "subjects")
      // subject 단위 상태판 — 순수 카운트 롤업(판단 아님·읽기전용).
      runGraphSubjects(getArg("--dir"), getArg("--format"));
    console.error("graph: 사용법 — graph query [--format json] · graph view --out <html> · graph failures [--by ...] · graph diff (--base-dir/--head-dir | --dir --base-commit/--head-commit) [--match fingerprint] · graph history (--claim <cfp|접두> | --input <sha> | --subject <s>) · graph subjects");
    process.exit(2);
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
    if (sub === "install-cursor") runCaptureInstallCursor(hasFlag("--write"));
    if (sub === "uninstall") runCaptureUninstall(hasFlag("--write"), hasFlag("--global"));
    const vendorArg = getArg("--vendor");
    const vendor =
      vendorArg === "cursor" || vendorArg === "claude" ? vendorArg : ("auto" as const);
    runCaptureIngest(getArg("--event"), vendor);
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
        committed: hasFlag("--committed"),
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
