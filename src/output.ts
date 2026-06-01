import type { Contract } from "./schema.js";
import type { VerifyResult } from "./checks.js";

const line = "─".repeat(56);

// 콘솔에 사람이 보기 좋은 검증 결과 출력
export function printReport(r: VerifyResult): void {
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

// 계약서 → Cursor/Claude에 붙여넣을 지시문 생성
export function buildPrompt(c: Contract): string {
  const out: string[] = [];
  out.push(`[작업 계약: ${c.id}]`);
  if (c.title) out.push(c.title);
  out.push("");
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
  out.push("  - 작업이 끝나면 commit/push 하지 말고 멈출 것");

  if (c.required_checks?.commands?.length) {
    out.push("");
    out.push("■ 작업 후 내가 돌릴 검사 (미리 통과하도록 작업할 것):");
    for (const cmd of c.required_checks.commands) out.push(`  - ${cmd.name}: ${cmd.command}`);
  }

  out.push("");
  out.push("■ 완료 보고 형식:");
  out.push("  - 수정한 파일 목록");
  out.push("  - 각 검사 통과 여부");
  out.push("  - 범위 밖 변경이 없음을 확인");
  return out.join("\n");
}
