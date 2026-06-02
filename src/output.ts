import type { Contract } from "./schema.js";
import type { VerifyResult, CheckResult } from "./checks.js";
import { resolveSession } from "./session.js";

const line = "─".repeat(56);

// verify FAIL 시 "다음 조치" 힌트(표시 전용 — 판정/exit/--json 에 영향 없음, 자동 revert 안 함).
// 계약의 git.* 플래그로 실제 위반 카테고리만 정확히 짚는다.
export function recoveryHints(r: VerifyResult, contract: Contract): string[] {
  const h: string[] = [];
  if (r.outOfScope.length) {
    h.push("범위 밖 변경: 검토 후 되돌리거나(git restore/checkout) 계약의 allowed_paths 를 넓히세요. (자동 revert 안 함)");
  }
  if (r.deniedHits.length && contract.git.require_no_denied_path_diff) {
    h.push("금지 경로 변경: commit 금지 — 되돌리기 / 별도 변경으로 분리 / denied_paths 글롭 조정 중 선택. (자동 revert 안 함)");
  }
  if (r.untracked.length && contract.git.require_no_staged_untracked) {
    h.push("정리 안 된 새 파일: 필요하면 git add+commit, 아니면 삭제/gitignore. ambient 노이즈면 `agent-receipt start` 로 baseline 을 찍으세요.");
  }
  return h;
}

// 콘솔에 사람이 보기 좋은 검증 결과 출력. contract 가 주어지면 FAIL 시 recovery hint 를 덧붙인다.
export function printReport(r: VerifyResult, contract?: Contract): void {
  console.log("");
  console.log(line);
  console.log(`작업계약 검증: ${r.contractId}`);
  if (r.title) console.log(r.title);
  console.log(line);

  console.log(
    `브랜치        : ${r.branch.current || "(없음)"}` +
      (r.branch.expected ? ` (기대: ${r.branch.expected}) ${r.branch.ok ? "OK" : "✗"}` : "")
  );

  console.log(`변경한 파일   : ${r.touched.length}개`);
  for (const f of r.touched) {
    const tag = r.outOfScope.includes(f) ? "  [범위밖]" : r.deniedHits.includes(f) ? "  [금지]" : "";
    console.log(`   - ${f}${tag}`);
  }

  console.log(`stage된 파일  : ${r.staged.length}개`);
  console.log(`새 파일(untracked): ${r.untracked.length}개`);
  for (const f of r.untracked) console.log(`   - ${f}`);

  console.log(
    `NUL 검사      : ${
      r.nulPaths.length ? (r.nulBad.length ? `✗ ${r.nulBad.join(", ")}` : "OK (0)") : "(대상 없음)"
    }`
  );

  if (r.commands.length) {
    console.log("필수 체크     :");
    for (const c of r.commands) {
      console.log(`   - ${c.name}: ${c.ok ? "OK" : "✗"} (exit ${c.exitCode})`);
    }
  }

  console.log(`로컬 커밋     : ${r.headHash}`);
  if (r.aheadBehind) {
    console.log(`origin/main 대비: +${r.aheadBehind.ahead} / -${r.aheadBehind.behind} (참고용)`);
  }

  console.log(line);
  if (r.ok) {
    console.log("결과: PASS ✅  계약을 지켰습니다.");
  } else {
    console.log(`결과: FAIL ❌  위반 ${r.violations.length}건`);
    for (const v of r.violations) console.log(`   ! ${v}`);
  }
  console.log(line);

  // 다음 조치 hint (FAIL + contract 있을 때만 — 표시 전용, 자동 revert 안 함).
  if (!r.ok && contract) {
    const hints = recoveryHints(r, contract);
    if (hints.length) {
      console.log("");
      console.log("다음 조치:");
      for (const x of hints) console.log(`   → ${x}`);
    }
  }

  // stale baseline 경고 (표시 전용 — 판정은 runVerify 가 이미 끝냄; --json/exit 에는 영향 없음).
  // session 파일은 있는데 무효(stale)라 full-tree 로 degrade 된 경우만 이유+해결책을 알려준다.
  const st = resolveSession();
  if (!st.applied && st.session) {
    console.log("");
    console.log("⚠️  baseline(.agent-guard/session.json)을 무시하고 full-tree 로 검사했습니다 (session 이 현재 상태와 안 맞음).");
    if (st.reason === "branch-mismatch") {
      console.log(`   이유: session 브랜치 '${st.session.gitBranch}' ≠ 현재 '${r.branch.current}'`);
    } else {
      console.log(`   이유: 기록된 baselineHead(${st.session.baselineHead}) 가 현재 HEAD 의 조상이 아님 (rebase/checkout?)`);
    }
    console.log("   해결: `agent-receipt reset` 후 `agent-receipt start` 로 새 baseline 을 찍으세요.");
  }

  console.log("");
}

// 보고서를 마크다운 파일로 저장할 때 쓰는 문자열 생성
export function toMarkdown(r: VerifyResult): string {
  const out: string[] = [];
  out.push(`# 작업계약 검증 보고서: ${r.contractId}`);
  if (r.title) out.push(`> ${r.title}`);
  out.push("");
  out.push(`- 결과: **${r.ok ? "PASS ✅" : "FAIL ❌"}**`);
  out.push(`- 브랜치: \`${r.branch.current}\`${r.branch.expected ? ` (기대 \`${r.branch.expected}\`)` : ""}`);
  out.push(`- 로컬 커밋: \`${r.headHash}\``);
  if (r.aheadBehind) out.push(`- origin/main 대비: +${r.aheadBehind.ahead} / -${r.aheadBehind.behind}`);
  out.push("");

  out.push(`## 변경한 파일 (${r.touched.length})`);
  for (const f of r.touched) {
    const tag = r.outOfScope.includes(f) ? " — ⚠️ 범위밖" : r.deniedHits.includes(f) ? " — ⛔ 금지" : "";
    out.push(`- \`${f}\`${tag}`);
  }
  if (!r.touched.length) out.push("- 없음");
  out.push("");

  out.push(`## 새 파일(untracked) (${r.untracked.length})`);
  for (const f of r.untracked) out.push(`- \`${f}\``);
  if (!r.untracked.length) out.push("- 없음");
  out.push("");

  out.push("## NUL 검사");
  out.push(r.nulPaths.length ? (r.nulBad.length ? `- ✗ ${r.nulBad.join(", ")}` : "- OK (0)") : "- 대상 없음");
  out.push("");

  out.push("## 필수 체크");
  if (r.commands.length) {
    for (const c of r.commands) out.push(`- ${c.name}: ${c.ok ? "OK" : "✗"} (exit ${c.exitCode})`);
  } else {
    out.push("- 없음");
  }
  out.push("");

  if (!r.ok) {
    out.push("## 위반 사항");
    for (const v of r.violations) out.push(`- ${v}`);
    out.push("");
  }
  return out.join("\n");
}

// ── 기계용 stable JSON ──
// 안정 계약을 위해 spec 필드만 명시적으로 추린다(키 집합·순서 고정).
// 내부 필드(commands, nulPaths, changed 등)는 의도적으로 제외한다.
// 옵셔널 필드(title, branch.expected)는 undefined여도 키가 사라지지 않게 ?? null 로 고정한다.
export type JsonReport = {
  ok: boolean;
  contractId: string;
  title: string | null;
  branch: { current: string; expected: string | null; ok: boolean };
  touched: string[];
  staged: string[];
  untracked: string[];
  outOfScope: string[];
  deniedHits: string[];
  stagedOutOfScope: string[];
  nulBad: string[];
  violations: string[];
  headHash: string;
  aheadBehind: { ahead: number; behind: number } | null;
};

export function toJsonReport(r: VerifyResult): JsonReport {
  return {
    ok: r.ok,
    contractId: r.contractId,
    title: r.title ?? null,
    branch: { current: r.branch.current, expected: r.branch.expected ?? null, ok: r.branch.ok },
    touched: r.touched,
    staged: r.staged,
    untracked: r.untracked,
    outOfScope: r.outOfScope,
    deniedHits: r.deniedHits,
    stagedOutOfScope: r.stagedOutOfScope,
    nulBad: r.nulBad,
    violations: r.violations,
    headHash: r.headHash,
    aheadBehind: r.aheadBehind,
  };
}

// check 명령 결과(필수 명령 실행)를 사람이 보기 좋게 출력
export function printCheckReport(r: CheckResult): void {
  console.log("");
  console.log(line);
  console.log(`필수 체크 실행: ${r.contractId}`);
  if (r.title) console.log(r.title);
  console.log(line);

  if (!r.commands.length) {
    console.log("검사할 명령 없음 (required_checks.commands 비어 있음 — 통과 처리)");
  } else {
    for (const c of r.commands) {
      // exit 127 은 코드 실패가 아니라 환경 문제(command not found / PATH)로 구분 표시.
      const envTag = c.env ? "  ← command not found / 환경 문제 (PATH/설치 확인)" : "";
      console.log(`   - ${c.name}: ${c.ok ? "OK" : "✗"} (exit ${c.exitCode}, 기대 ${c.requiredExit})${envTag}`);
    }
  }

  console.log(line);
  if (r.ok) {
    console.log("결과: PASS ✅  모든 명령 통과.");
  } else {
    const failed = r.commands.filter((c) => !c.ok).length;
    console.log(`결과: FAIL ❌  실패 ${failed}건`);
  }
  console.log(line);
  console.log("");
}

export type PromptVariant = "generic" | "cursor" | "claude";

// 변종별 머리말. 공통 body(규칙 + 완료보고 JSON)는 promptBody 가 재사용한다.
// 완료보고 JSON 형식은 세 변종 모두 동일(claims 입력 호환).
function promptHeader(c: Contract, variant: PromptVariant): string[] {
  const h: string[] = [];
  if (variant === "cursor") {
    h.push(`[Cursor 지시 — 작업 계약: ${c.id}]`);
    if (c.title) h.push(c.title);
    h.push("");
    h.push("아래 규칙을 그대로 지켜 작업하라(짧고 명령형). 요청한 것만 — 추가 개선/리팩터링 금지.");
    h.push("허용 scope 밖이 필요하면 진행하지 말고 멈춰서 물어라. 끝나면 아래 완료보고 JSON 만 정확히 붙여라.");
  } else if (variant === "claude") {
    h.push(`[Claude 작업 계약: ${c.id}]`);
    if (c.title) h.push(c.title);
    h.push("");
    h.push("이 작업은 '작업 계약 → 작업 → 검증' 루프다. 작업이 끝나면 사람이");
    h.push("`agent-receipt verify`(상태)·`check`(테스트)·`claims`(완료보고 ↔ git 대조)로 결과를 기계 검증한다.");
    h.push("commit/push/deploy 는 하지 말고, 완료 후 아래 JSON claim 을 제출하라.");
  } else {
    h.push(`[작업 계약: ${c.id}]`);
    if (c.title) h.push(c.title);
  }
  h.push("");
  return h;
}

// 계약서 → Cursor/Claude에 붙여넣을 지시문 생성. variant 별 머리말만 다르고 본문/완료 JSON 은 공통.
export function buildPrompt(c: Contract, variant: PromptVariant = "generic"): string {
  const out: string[] = promptHeader(c, variant);
  out.push("이번 작업에서 반드시 지켜야 할 규칙이다.");
  out.push("");
  out.push("■ 수정해도 되는 파일 (오직 이 파일들만):");
  for (const p of c.scope.allowed_paths) out.push(`  - ${p}`);

  if (c.scope.denied_paths.length) {
    out.push("");
    out.push("■ 절대 건드리면 안 되는 파일/폴더:");
    for (const p of c.scope.denied_paths) out.push(`  - ${p}`);
  }

  if (c.forbidden_actions.length) {
    out.push("");
    out.push("■ 금지 행동:");
    for (const a of c.forbidden_actions) out.push(`  - ${a}`);
  }

  out.push("");
  out.push("■ 공통 규칙:");
  out.push("  - 허용 파일 외에는 생성/수정/삭제 금지");
  out.push("  - 문서/메모/임시 리포트 같은 새 파일 만들지 말 것");
  out.push("  - 허용 scope 밖 작업이 필요하면, 진행하지 말고 멈춰서 사람에게 물어볼 것");
  out.push("  - 요청하지 않은 추가 개선/리팩터링 금지 (요청한 것만)");
  out.push("  - 작업이 끝나면 commit / push / deploy 하지 말고 멈출 것");

  if (c.required_checks?.commands?.length) {
    out.push("");
    out.push("■ 작업 후 내가 돌릴 검사 (미리 통과하도록 작업할 것):");
    for (const cmd of c.required_checks.commands) out.push(`  - ${cmd.name}: ${cmd.command}`);
  }

  out.push("");
  out.push("■ 완료 보고 — 아래 JSON 을 그대로 붙일 것 (사람이 `agent-receipt claims --file` 로 git 과 대조한다):");
  out.push("  {");
  out.push('    "changedFiles": ["수정/생성한 파일 상대경로", "..."],');
  out.push('    "newFiles": ["새로 만든 파일", "..."],');
  out.push('    "deniedHits": [],');
  out.push('    "tests": true,');
  out.push('    "summary": "무엇을 했는지 한 줄"');
  out.push("  }");
  out.push("  - 이 보고는 '주장'일 뿐이며 git 실측과 다르면 mismatch 로 잡힌다. 변경을 숨기지 말 것.");
  return out.join("\n");
}
