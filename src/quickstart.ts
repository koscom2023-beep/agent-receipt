import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { POLICY_REL } from "./policy.js";
import { t } from "./lang.js";

// v0.20 결정5 (council 2026-07-07) — quickstart: 첫 성공 경험을 한 명령으로.
// 원칙: **인쇄 우선(print-first)** — 기본은 뭘 할지 보여주기만 하고 파일시스템 무변경.
//        `--write` 에서만 실제 기록하며, 실행은 자기 CLI 를 순차 호출(각 명령의 고지/출력 그대로 통과 —
//        기존 run* 함수 재구현 0·install-cursor 의 print-first 선례 승계).
// 정직: quickstart 는 마법이 아니라 기존 4단계의 안내서다 — 각 단계가 어떤 파일을 만드는지 먼저 말한다.

const line = "─".repeat(56);

interface Step {
  cmd: string[]; // 자기 CLI 인자
  writes: string; // 어떤 파일을 만드나(인쇄용)
  skipIf?: string; // 이 경로가 있으면 skip(멱등)
  note?: string;
}

export function runQuickstart(write: boolean, cwd: string = process.cwd()): never {
  // U2 — 핵심 셋업은 계약+정책 둘뿐(자동). capture 는 첫 세션 부담(공유 설정 수정)이라 선택으로 강등(자동 실행 안 함).
  const steps: Step[] = [
    {
      cmd: ["init", "--preset", "generic"],
      writes: ".agent-guard/contract.yaml (+README) — 이번 작업의 계약(범위·금지 경로)",
      skipIf: join(cwd, ".agent-guard", "contract.yaml"),
    },
    {
      cmd: ["policy", "init", "--profile", "solo-founder"],
      writes: `${POLICY_REL} — 프로젝트 상시 규칙(가드 warn 기본)`,
      skipIf: join(cwd, POLICY_REL),
    },
  ];
  console.log("");
  console.log(line);
  console.log(`agent-receipt quickstart ${write ? "(--write · 실제 기록)" : "(인쇄 전용 — 파일시스템 무변경)"}`);
  console.log(line);
  console.log(t("qs.core")); // 핵심 = 세 동사(begin·done·share) · 아래는 그 준비
  console.log(line);
  const cliPath = process.argv[1] ?? "agent-receipt";
  let n = 0;
  for (const s of steps) {
    n++;
    const skipped = s.skipIf ? existsSync(s.skipIf) : false;
    console.log(`[${n}] agent-receipt ${s.cmd.join(" ")}`);
    console.log(`    만드는 것: ${s.writes}${skipped ? "  → 이미 있음(skip)" : ""}`);
    if (s.note) console.log(`    참고: ${s.note}`);
    if (write && !skipped) {
      const r = spawnSync(process.execPath, [cliPath, ...s.cmd], { cwd, stdio: "inherit" });
      if (r.status !== 0) console.log(`    ⚠️ exit ${r.status} — 이 단계는 건너뛰고 계속합니다(quickstart 는 안내서·게이트 아님).`);
    }
  }
  console.log(`[${n + 1}] agent-receipt begin --kind implementation`);
  console.log("    만드는 것: 세션 baseline — 이때부터 '세션 단위' 측정(없으면 판정 INCOMPLETE ◌)");
  console.log("    (begin 은 kind 선택이 필요해 quickstart 가 대신 실행하지 않습니다.)");
  console.log(line);
  // U2 — capture 는 선택(나중에). 첫 성공에 불필요하므로 항상 인쇄만(--write 여도 자동 실행 안 함).
  console.log(t("qs.captureLater"));
  console.log("    agent-receipt capture install --write   .claude/settings.json 병합(⚠️ 공유 설정 수정·동시 세션 영향)");
  console.log("    Claude Code 밖(Cursor 등)이면: agent-receipt capture install-cursor");
  console.log(line);
  if (!write) {
    console.log("지금은 인쇄만 했습니다 — 실제 기록: agent-receipt quickstart --write");
  } else {
    console.log("기록 완료 — 다음: agent-receipt begin --kind <kind> → 작업 → done → share");
  }
  console.log("  끝나면: done(판정) → share(공유 HTML) · 왜 PASS/FAIL 인지: explain");
  console.log(line);
  console.log("");
  process.exit(0);
}
