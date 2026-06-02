import type { Contract } from "./schema.js";

const line = "─".repeat(56);

/**
 * `agent-receipt lint` — 계약 품질 조언(advisory). 스키마는 loadContract 가 이미 검증하므로
 * 여기서는 "의도했는지" 경고만 낸다. 항상 exit 0(권고용 — 게이트 아님).
 */
export function runLint(contract: Contract): never {
  const warns: string[] = [];

  if (contract.scope.allowed_paths.length === 0) {
    warns.push("allowed_paths 비어 있음 → positive 범위검사가 꺼집니다. 의도면 OK, 아니면 허용 경로를 명시하세요.");
  }
  for (const p of contract.scope.denied_paths) {
    if (p === "**" || p === "*" || p === "**/*") {
      warns.push(`denied_paths '${p}' 가 너무 넓음 → 거의 모든 변경을 금지로 잡습니다.`);
    }
  }
  if (contract.forbidden_actions.length) {
    warns.push("forbidden_actions 는 advisory 입니다 — verify 가 기계적으로 막지 않습니다(CONTRACT.md §7).");
  }
  if ((contract.required_checks?.commands?.length ?? 0) === 0) {
    warns.push("required_checks.commands 가 비어 있음 → 'check' 는 항상 통과(vacuous). tsc/test 등을 추가하면 좋습니다.");
  }

  // Promptia preset(id: promptia) 감지 → 핵심 denied_paths 누락을 사실로만 경고(점수화 없음).
  if (contract.id === "promptia") {
    const denied = new Set(contract.scope.denied_paths);
    const essentials: Array<{ glob: string; why: string }> = [
      { glob: ".env*", why: "비밀/환경변수" },
      { glob: "supabase/migrations/**", why: "DB 스키마 마이그레이션" },
      { glob: "vercel.json", why: "배포 설정" },
      { glob: ".vercel/**", why: "배포 산출물" },
      { glob: "exports/**", why: "내보내기 산출물" },
      { glob: "docs/arch/json/**", why: "아키텍처 JSON 산출물" },
    ];
    for (const e of essentials) {
      if (!denied.has(e.glob)) warns.push(`[promptia] denied_paths 에 '${e.glob}' 없음 (${e.why}) — 추가 권장.`);
    }
    if (!denied.has("package-lock.json") && !denied.has("pnpm-lock.yaml")) {
      warns.push("[promptia] denied_paths 에 lockfile(package-lock.json / pnpm-lock.yaml) 없음 — 추가 권장.");
    }
  }

  console.log("");
  console.log(line);
  console.log(`agent-receipt lint: ${contract.id}`);
  console.log(line);
  if (!warns.length) console.log("  ✓ 경고 없음");
  else for (const w of warns) console.log(`  ⚠ ${w}`);
  console.log(line);
  console.log(`결과: 경고 ${warns.length}건 (advisory)`);
  console.log("");
  process.exit(0);
}
