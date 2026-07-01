import { SCHEMA_VERSION, CHECK_KINDS, claimSchema } from "./evidencekernel.js";

const line = "─".repeat(56);

// ── Evidence Specification (표준 포맷 방출) ──
// 피드백: 해자는 개별 체커가 아니라 "AI 증적의 표준 포맷"이다(Git의 객체모델이 표준이 됐듯).
// `spec` 은 그 포맷을 사람요약/기계판독(JSON Schema)으로 방출한다 — 남이 그대로 채택할 수 있는 표면.
// 스키마는 check 레지스트리에서 생성된다(코드가 곧 스펙·단일 출처).

/**
 * `agent-receipt spec [--format json]`
 *  - 기본: 사람 요약(check kinds·상태·보증범위·재현성)
 *  - --format json: JSON Schema(draft-07) — 기계판독·채택용
 */
export function runSpec(format: string | undefined): never {
  if (format === "json") {
    console.log(JSON.stringify(claimSchema(), null, 2));
    process.exit(0);
  }
  console.log("");
  console.log(line);
  console.log(`agent-receipt — Evidence Specification (${SCHEMA_VERSION})`);
  console.log(line);
  console.log("AI 작업의 근거를 담는 표준 포맷. 하나의 claim 이 여러 typed check 를 담고,");
  console.log("각 check 는 모델 밖 결정론(비-LLM)으로 pass/fail 판정된다.");
  console.log("");
  console.log(`검증 종류(check kinds): ${CHECK_KINDS.join(" · ")}`);
  console.log("상태: verified · not-found · mismatch · invalid · no-source · no-basis · valid(advisory)");
  console.log("");
  console.log("보증 범위(정직·좁게):");
  console.log("  · 보증함 — 주장이 제시한 근거(인용·수치·계산·날짜·링크·해시)가 출처/재계산과 정합한가.");
  console.log("  · 보증 안 함 — AI 판단이 옳은가(결론의 합리성·누락·대안)는 사람/다른 절차의 몫.");
  console.log("재현성: 같은 입력이면 어느 PC에서 돌려도 같은 결과(deterministic). 모델·벤더 불문.");
  console.log("");
  console.log("기계판독 스키마: agent-receipt spec --format json  (JSON Schema draft-07)");
  console.log("새 검증기는 check 레지스트리에 등록만 하면 이 스펙에 자동 반영(엔진 불변).");
  console.log(line);
  console.log("");
  process.exit(0);
}
