import type { Receipt } from "./receipt.js";
import type { Contract } from "./schema.js";

// P0 v0.17 (council 2026-07-07 D1·D2) — 세션 판정 + 계약 스냅샷.
//
// 🔴 판정은 **카테고리 게이트이지 점수가 아니다**(DA-2 수용): 숫자 점수·등급평균·0~100 없음.
//   기존 신호(verify ok·denied/outOfScope·checks·critical·policy·waste·redflag·session 상태)의
//   순수 롤업이며, 각 판정은 항목별 사실(reasons)로 뒷받침되고 그것을 **대체하지 않는다**.
// 우선순위(결정론): FAIL > INCOMPLETE > PASS_WITH_WARNINGS > PASS.
//   INCOMPLETE 정의(고정): 계약 위반은 없으나 측정 기반이 불완전 — baseline 없음(begin 미실행) 또는 stale.
export type SessionVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "INCOMPLETE";
export interface VerdictResult {
  verdict: SessionVerdict;
  reasons: string[]; // 사람이 읽는 사실 목록 — 판정의 근거(항목 사실을 요약·참조)
}
export const VERDICT_MARK: Record<SessionVerdict, string> = {
  PASS: "✅",
  PASS_WITH_WARNINGS: "⚠️",
  FAIL: "❌",
  INCOMPLETE: "◌",
};

type ReceiptLike = Pick<Receipt, "ok" | "deniedHits" | "outOfScope" | "checks" | "criticalPaths" | "session" | "violations"> & {
  policy?: Receipt["policy"];
};
export interface VerdictExtras {
  wasteSignal?: boolean; // done 이 계산한 가드/반복 낭비 1줄 존재 여부(상세는 본문 라인이 보여줌)
  redFlags?: string[]; // reviewfocus 확인 신호(예: test .only · 의존성 추가)
}

const few = (xs: string[], n = 5): string => xs.slice(0, n).join(", ") + (xs.length > n ? ` 외 ${xs.length - n}` : "");

export function sessionVerdict(r: ReceiptLike, extra: VerdictExtras = {}): VerdictResult {
  // 1) FAIL — 계약/검사 위반(어떤 이유든 verify·check 가 실패).
  if (!r.ok) {
    const reasons: string[] = [];
    if (r.deniedHits.length) reasons.push(`금지 경로 변경 ${r.deniedHits.length}건: ${few(r.deniedHits)}`);
    if (r.outOfScope.length) reasons.push(`허용 범위 밖 변경 ${r.outOfScope.length}건: ${few(r.outOfScope)}`);
    const failedChecks = r.checks.filter((c) => !c.ok);
    if (failedChecks.length) reasons.push(`필수 검사 실패 ${failedChecks.length}건: ${few(failedChecks.map((c) => c.name))}`);
    if (!reasons.length) reasons.push(...(r.violations.length ? r.violations : ["verify FAIL(상세는 explain)"]));
    return { verdict: "FAIL", reasons };
  }
  // 2) INCOMPLETE — 위반은 없으나 측정 기반 불완전(정의 고정: baseline 없음/stale).
  if (r.session === null) {
    return { verdict: "INCOMPLETE", reasons: ["baseline 없음(begin 미실행) — 전체 트리 측정만 수행·세션 경계 불명"] };
  }
  if (!r.session.applied) {
    return { verdict: "INCOMPLETE", reasons: [`baseline stale(${r.session.reason ?? "사유 미기록"}) — 세션 측정 기반 불완전`] };
  }
  // 3) PASS_WITH_WARNINGS — 통과했으나 사람이 봐야 할 신호.
  const warns: string[] = [];
  const crit = r.criticalPaths.filter((c) => c.touched.length);
  if (crit.length) warns.push(`고위험 경로 변경: ${few(crit.map((c) => c.glob))}`);
  if (r.policy?.forbidAlwaysHits.length) warns.push(`정책 상시금지 경로 접촉: ${few(r.policy.forbidAlwaysHits)}`);
  if (extra.wasteSignal) warns.push("가드/반복 낭비 신호 있음(아래 상세 줄 참고)");
  if (extra.redFlags?.length) warns.push(`확인 신호 ${extra.redFlags.length}건: ${few(extra.redFlags, 3)}`);
  if (warns.length) return { verdict: "PASS_WITH_WARNINGS", reasons: warns };
  // 4) PASS
  return { verdict: "PASS", reasons: ["계약 준수 · 필수 검사 통과 · 경고 신호 없음"] };
}

// D2 — 계약 스냅샷(최소필드+contractHash 포인터·전체 복사 아님). receipt 최상단 표면화용 metadata.
export interface ContractSnapshot {
  contractId: string;
  kind: string | null; // begin --kind (session 에서)
  allowedGlobs: number; // 목록 대신 개수(비대 방지) — denied 는 위험표면이라 목록
  deniedGlobs: string[];
  forbiddenActions: string[]; // advisory — 기계 강제 아님
  budget: { maxTouchedFiles?: number; maxNewFiles?: number } | null;
  contractHash: string | null; // environment.contractHash 포인터
}

export function buildContractSnapshot(
  c: Contract,
  r: Pick<Receipt, "contractId" | "session" | "environment">,
): ContractSnapshot {
  return {
    contractId: r.contractId,
    kind: r.session?.kind ?? null,
    allowedGlobs: c.scope.allowed_paths.length,
    deniedGlobs: [...c.scope.denied_paths],
    forbiddenActions: [...c.forbidden_actions],
    budget: c.budget
      ? {
          ...(c.budget.max_touched_files !== undefined ? { maxTouchedFiles: c.budget.max_touched_files } : {}),
          ...(c.budget.max_new_files !== undefined ? { maxNewFiles: c.budget.max_new_files } : {}),
        }
      : null,
    contractHash: r.environment.contractHash ?? null,
  };
}

// 렌더(공유): done 헤더·receipt md·share-proof 가 같은 문구를 쓴다(표류 방지).
export function renderContractLine(s: ContractSnapshot): string {
  const parts = [
    s.kind ? `kind=${s.kind}` : null,
    `allowed ${s.allowedGlobs} globs`,
    s.deniedGlobs.length ? `denied: ${few(s.deniedGlobs, 4)}` : "denied: (없음)",
    s.forbiddenActions.length ? `금지행위(advisory): ${few(s.forbiddenActions, 4)}` : null,
    s.budget ? `budget: ${[s.budget.maxTouchedFiles !== undefined ? `touched≤${s.budget.maxTouchedFiles}` : null, s.budget.maxNewFiles !== undefined ? `new≤${s.budget.maxNewFiles}` : null].filter(Boolean).join(" ")}` : null,
  ].filter(Boolean);
  return `계약: ${parts.join(" · ")}`;
}
export function renderVerdictLine(v: VerdictResult): string {
  return `판정: ${v.verdict} ${VERDICT_MARK[v.verdict]}  (게이트 판정 — 점수 아님)`;
}
