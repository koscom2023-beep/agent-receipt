#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadContract, type Contract } from "./schema.js";
import { runVerify } from "./checks.js";
import { printReport, toMarkdown, buildPrompt } from "./output.js";
import * as g from "./git.js";

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireRepo(): void {
  if (!g.isGitRepo()) {
    console.error("여기는 git 저장소가 아님. 저장소 루트에서 실행하세요.");
    process.exit(2);
  }
}

function printHelp(): void {
  console.log(`
agent-guard — AI 작업계약 검수 CLI

사용법:
  guard verify  --contract <path.yaml>   변경 diff/범위/NUL/테스트 검사 (실패 시 exit 1)
  guard report  --contract <path.yaml>   verify + 마크다운 보고서 저장 (--out 으로 경로 지정)
  guard pre     --contract <path.yaml>   작업 시작 전 안전 점검
  guard prompt  --contract <path.yaml>   Cursor/Claude에 붙여넣을 지시문 생성
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

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }

  const contractPath = getArg("--contract") ?? getArg("-c");
  if (!contractPath) {
    console.error("계약서 경로가 필요함:  guard <command> --contract <path.yaml>");
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
      printReport(r);
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
