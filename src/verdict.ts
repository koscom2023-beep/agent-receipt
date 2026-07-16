import type { Receipt } from "./receipt.js";
import type { Contract } from "./schema.js";
import type { ObservationHealth } from "./observation.js";

// P0 v0.17 (council 2026-07-07 D1·D2) — 세션 판정 + 계약 스냅샷.
// P1 v0.18 (council 2026-07-07 D1~D3) — 판정 규칙 명문화:
//   · VERDICT_RULES 레지스트리(코드가 곧 스펙) + docs/VERDICT.md(레지스트리와 id 일치 — 테스트가 대조)
//   · reason 은 `[rule-id] 사실` 형식(사람+기계 동시 판독·id 는 VERDICT_RULES)
//   · INCOMPLETE 사유 코드 세분 + "고치는 법" 병기
//   · fail_on_done 임계 헬퍼(게이트는 opt-in — done 이 policy 를 읽어 exit 만 올림·판정 자체는 불변)
//
// 🔴 판정은 **카테고리 게이트이지 점수가 아니다**(DA-2 수용): 숫자 점수·등급평균·0~100 없음.
//   기존 신호(verify ok·denied/outOfScope·checks·critical·policy·waste·redflag·session 상태)의
//   순수 롤업이며, 각 판정은 항목별 사실(reasons)로 뒷받침되고 그것을 **대체하지 않는다**.
// 우선순위(결정론): FAIL > INCOMPLETE > PASS_WITH_WARNINGS > PASS.
//   INCOMPLETE 정의(고정): 계약 위반은 없으나 측정 기반이 불완전하다. 축이 둘이다.
//     · 측정 창(baseline): begin 미실행 또는 stale.
//     · 관찰 배선(observation·P0-1 2026-07-16): 훅을 깔고도 창 안 기록이 0(silent)이거나 기록이 손상(degraded).
//   관찰이 빈 채로 PASS 를 찍으면 영수증이 과대 주장을 한다(2026-07-16 실측: 44일 행동 0건인데 PASS 다수).
export type SessionVerdict = "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "INCOMPLETE";
export interface VerdictResult {
  verdict: SessionVerdict;
  reasons: string[]; // 사람이 읽는 사실 목록 — 판정의 근거. 형식: `[rule-id] 사실`(PASS 만 id 없음=발동 규칙 0)
}
export const VERDICT_MARK: Record<SessionVerdict, string> = {
  PASS: "✅",
  PASS_WITH_WARNINGS: "⚠️",
  FAIL: "❌",
  INCOMPLETE: "◌",
};

// ── P1 D1: 판정 규칙 레지스트리 — 어떤 사실이 어떤 판정을 만드나(전수·명문). docs/VERDICT.md 가 이 표를 서술한다. ──
// 발동 로직은 sessionVerdict 본문(기존 신호 그대로) — 레지스트리는 그 로직의 명문표이지 새 판정원천이 아니다.
export interface VerdictRule {
  id: string;
  verdict: SessionVerdict;
  when: string; // 발동 조건(사람말·결정론 조건 서술)
}
export const VERDICT_RULES: readonly VerdictRule[] = [
  // FAIL — 원천은 계약/검사 위반(verify FAIL)뿐.
  { id: "denied-path", verdict: "FAIL", when: "계약 denied_paths 에 매치되는 변경이 있음" },
  { id: "out-of-scope", verdict: "FAIL", when: "계약 allowed_paths 밖 변경이 있음(allowed 지정 시)" },
  { id: "check-failed", verdict: "FAIL", when: "계약 checks 명령이 요구 exit 와 다르게 끝남" },
  { id: "verify-fail", verdict: "FAIL", when: "그 외 verify 위반(violations 항목)" },
  // INCOMPLETE — 위반은 없으나 측정 기반 불완전(코드별 고치는 법은 incompleteDetail).
  { id: "no-baseline", verdict: "INCOMPLETE", when: "begin 미실행 — 세션 baseline 없음(전체 트리 측정만 수행)" },
  { id: "stale-branch-mismatch", verdict: "INCOMPLETE", when: "begin 때와 다른 브랜치에서 측정됨" },
  { id: "stale-baseline-not-ancestor", verdict: "INCOMPLETE", when: "baseline 커밋이 현재 HEAD 의 조상이 아님(rebase/reset/amend 흔적)" },
  { id: "stale-unknown", verdict: "INCOMPLETE", when: "baseline 미적용(기타·사유 미기록)" },
  // 관찰 배선 축(P0-1). 측정 창과 별개다. unavailable(훅 미설치 확인)은 정상 상태라 규칙이 아니며 영수증이 범위만 공시한다.
  { id: "observation-silent", verdict: "INCOMPLETE", when: "측정 창 안 행동 관찰 증거 0건(원인 미확정, 훅 배선은 있음)" },
  { id: "observation-degraded", verdict: "INCOMPLETE", when: "행동 기록 손상(열화 마커·체인 문제·꼬리 잘림)" },
  // PASS_WITH_WARNINGS — 통과했으나 사람이 봐야 할 신호. 자동 승격 없음(아래 WARN_ESCALATION_NOTE).
  { id: "critical-path", verdict: "PASS_WITH_WARNINGS", when: "계약 critical_paths 에 매치되는 변경이 있음" },
  { id: "policy-forbid", verdict: "PASS_WITH_WARNINGS", when: "policy forbidAlways 에 매치되는 변경이 있음" },
  { id: "waste-signal", verdict: "PASS_WITH_WARNINGS", when: "capture 에 가드 경고/차단·반복 낭비 신호가 있음" },
  { id: "red-flag", verdict: "PASS_WITH_WARNINGS", when: "확인 신호 — 추가된 줄의 test .only/.skip 또는 의존성 추가" },
];
// P1 D1 핵심 문장(감사 관점·불변): WARN 의 승격 경로를 코드가 명문으로 부정한다.
export const WARN_ESCALATION_NOTE =
  "WARN(PASS_WITH_WARNINGS)은 FAIL 로 자동 승격되지 않는다 — FAIL 의 원천은 계약/검사 위반(verify FAIL)뿐. " +
  "승격은 사람 판단이며, 원하면 policy fail_on_done 으로 exit 게이트만 opt-in 할 수 있다(판정 자체는 불변).";

// ── P1 D2: INCOMPLETE 사유 세분 — code + 사실 + 고치는 법(고정 매핑·session.ts 의 reason enum 실측 기반) ──
// P0-1(2026-07-16 정본): 관찰 사유 2종 추가. baseline 이 멀쩡해도 관찰이 비면 PASS 는 과대 주장이다.
export type IncompleteCode = "no-baseline" | "stale-branch-mismatch" | "stale-baseline-not-ancestor" | "stale-unknown" | "observation-silent" | "observation-degraded";
export interface IncompleteDetail {
  code: IncompleteCode;
  text: string; // 무엇이 불완전한가(사실)
  fix: string; // 어떻게 고치나(명령 포함·고정 매핑 — LLM 추천 아님)
}
type SessionLike = Pick<Receipt, "session">["session"];
export function incompleteDetail(session: SessionLike): IncompleteDetail | null {
  if (session === null) {
    return {
      code: "no-baseline",
      text: "baseline 없음(begin 미실행) — 전체 트리 측정만 수행·세션 경계 불명",
      fix: "작업 시작 전 `agent-receipt begin --kind <kind>` 실행(그 시점부터 세션 단위 측정)",
    };
  }
  if (session.applied) return null;
  if (session.reason === "branch-mismatch") {
    return {
      code: "stale-branch-mismatch",
      text: "baseline stale(branch-mismatch) — begin 때와 다른 브랜치에서 측정됨",
      fix: "begin 한 브랜치로 돌아가거나, 현 브랜치에서 `agent-receipt begin` 재실행",
    };
  }
  if (session.reason === "baseline-not-ancestor") {
    return {
      code: "stale-baseline-not-ancestor",
      text: "baseline stale(baseline-not-ancestor) — begin 시점 커밋이 현재 HEAD 의 조상이 아님(rebase/reset/amend 흔적)",
      fix: "`agent-receipt begin` 재실행(현재 HEAD 로 새 baseline 고정)",
    };
  }
  return {
    code: "stale-unknown",
    text: `baseline stale(${session.reason ?? "사유 미기록"}) — 세션 측정 기반 불완전`,
    fix: "`agent-receipt begin` 재실행",
  };
}

// ── P1 D3: fail_on_done 임계(정책 opt-in 게이트) — 심각도는 우선순위와 동일 서열 ──
export const VERDICT_SEVERITY: Record<SessionVerdict, number> = { PASS: 0, PASS_WITH_WARNINGS: 1, INCOMPLETE: 2, FAIL: 3 };
export type FailOnDoneThreshold = "fail" | "incomplete" | "warn";
const THRESHOLD_SEVERITY: Record<FailOnDoneThreshold, number> = { fail: 3, incomplete: 2, warn: 1 };
/** 판정이 임계 이상이면 true — done 이 exit 1 로 올릴지 결정(판정/출력 자체는 불변·순수함수). */
export function failOnDoneTriggers(verdict: SessionVerdict, threshold: FailOnDoneThreshold): boolean {
  return VERDICT_SEVERITY[verdict] >= THRESHOLD_SEVERITY[threshold];
}

type ReceiptLike = Pick<Receipt, "ok" | "deniedHits" | "outOfScope" | "checks" | "criticalPaths" | "session" | "violations"> & {
  policy?: Receipt["policy"];
};
export interface VerdictExtras {
  wasteSignal?: boolean; // done 이 계산한 가드/반복 낭비 1줄 존재 여부(상세는 본문 라인이 보여줌)
  redFlags?: string[]; // reviewfocus 확인 신호(예: test .only · 의존성 추가)
  // P0-1: 관찰 상태. 미제공(undefined)이면 관찰 판정을 건너뛴다(기존 호출자 판정 불변).
  observation?: Pick<ObservationHealth, "verdict" | "text" | "fix">;
}

/**
 * 관찰 상태 → INCOMPLETE 사유. 트리거를 좁게 잡는다(안전은 트리거 정확성으로).
 *  - silent     : 창 안 관찰 증거 0 → INCOMPLETE(원인은 단정하지 않는다. 못 본 것과 없는 것은 다르다)
 *  - degraded    : 기록 손상 = 숫자를 믿을 수 없음 → INCOMPLETE
 *  - unavailable: git 전용 사용자의 정상 상태 → INCOMPLETE 아님(관찰 범위는 영수증이 따로 공시)
 *  - observed    : 정상
 */
export function observationIncomplete(o: VerdictExtras["observation"]): IncompleteDetail | null {
  if (!o) return null;
  if (o.verdict === "silent") return { code: "observation-silent", text: o.text, fix: o.fix ?? "`agent-receipt doctor` 로 훅 설치·최근 수신 확인 후 재측정" };
  if (o.verdict === "degraded") return { code: "observation-degraded", text: o.text, fix: o.fix ?? "`agent-receipt capture verify` 로 확인" };
  return null;
}

const few = (xs: string[], n = 5): string => xs.slice(0, n).join(", ") + (xs.length > n ? ` 외 ${xs.length - n}` : "");

export function sessionVerdict(r: ReceiptLike, extra: VerdictExtras = {}): VerdictResult {
  // 1) FAIL — 계약/검사 위반(어떤 이유든 verify·check 가 실패). reason 형식: [rule-id] 사실.
  if (!r.ok) {
    const reasons: string[] = [];
    if (r.deniedHits.length) reasons.push(`[denied-path] 금지 경로 변경 ${r.deniedHits.length}건: ${few(r.deniedHits)}`);
    if (r.outOfScope.length) reasons.push(`[out-of-scope] 허용 범위 밖 변경 ${r.outOfScope.length}건: ${few(r.outOfScope)}`);
    const failedChecks = r.checks.filter((c) => !c.ok);
    if (failedChecks.length) reasons.push(`[check-failed] 필수 검사 실패 ${failedChecks.length}건: ${few(failedChecks.map((c) => c.name))}`);
    if (!reasons.length) {
      reasons.push(...(r.violations.length ? r.violations.map((v) => `[verify-fail] ${v}`) : ["[verify-fail] verify FAIL(상세는 explain)"]));
    }
    return { verdict: "FAIL", reasons };
  }
  // 2) INCOMPLETE — 위반은 없으나 측정 기반 불완전(D2: code + 고치는 법 병기).
  //    baseline(측정 창)과 observation(관찰 배선)은 다른 축이다. 둘 다 불완전하면 둘 다 낸다.
  const inc = incompleteDetail(r.session);
  const obsInc = observationIncomplete(extra.observation);
  if (inc || obsInc) {
    const reasons = [inc, obsInc].filter((x): x is IncompleteDetail => x !== null).map((x) => `[${x.code}] ${x.text} · 고치는 법: ${x.fix}`);
    return { verdict: "INCOMPLETE", reasons };
  }
  // 3) PASS_WITH_WARNINGS — 통과했으나 사람이 봐야 할 신호(WARN_RULES·자동 승격 없음).
  const warns: string[] = [];
  const crit = r.criticalPaths.filter((c) => c.touched.length);
  if (crit.length) warns.push(`[critical-path] 고위험 경로 변경: ${few(crit.map((c) => c.glob))}`);
  if (r.policy?.forbidAlwaysHits.length) warns.push(`[policy-forbid] 정책 상시금지 경로 접촉: ${few(r.policy.forbidAlwaysHits)}`);
  if (extra.wasteSignal) warns.push("[waste-signal] 가드/반복 낭비 신호 있음(아래 상세 줄 참고)");
  if (extra.redFlags?.length) warns.push(`[red-flag] 확인 신호 ${extra.redFlags.length}건: ${few(extra.redFlags, 3)}`);
  if (warns.length) return { verdict: "PASS_WITH_WARNINGS", reasons: warns };
  // 4) PASS — 발동 규칙 0(그래서 id 없음).
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

// ── v0.20 결정2: 계약 자연어화 — 고정 템플릿 슬롯 치환(한/영 병기·LLM 0·결정론) ──
// done 헤더는 현행 압축줄(renderContractLine) 유지 — share-proof 만 문장형을 병기한다(같은 스냅샷 SSOT).
const KIND_KO: Record<string, string> = {
  implementation: "구현",
  recon: "정찰(읽기 위주)",
  docs: "문서",
  test: "테스트",
  "measure-first": "측정 우선",
  "observe-only": "관찰 전용",
  "release-check": "배포 점검",
};
export function renderContractProse(s: ContractSnapshot): { ko: string; en: string } {
  const kindKo = s.kind ? (KIND_KO[s.kind] ?? s.kind) : "종류 미지정";
  const kindEn = s.kind ?? "unspecified-kind";
  const denied = s.deniedGlobs; // 위험표면 — 전수 나열(수용기준)
  const koParts: string[] = [];
  koParts.push(`이번 세션은 ${kindKo} 작업으로 계약되었습니다.`);
  koParts.push(
    denied.length
      ? `${denied.join(", ")} 은(는) 건드리지 않기로 했습니다.`
      : "금지 경로는 지정되지 않았습니다.",
  );
  if (s.forbiddenActions.length) koParts.push(`하지 않기로 약속한 행위(권고·기계 강제 아님): ${s.forbiddenActions.join(", ")}.`);
  if (s.budget) {
    const b: string[] = [];
    if (s.budget.maxTouchedFiles !== undefined) b.push(`변경 파일 ${s.budget.maxTouchedFiles}개 이하`);
    if (s.budget.maxNewFiles !== undefined) b.push(`새 파일 ${s.budget.maxNewFiles}개 이하`);
    if (b.length) koParts.push(`변경 예산: ${b.join(" · ")}.`);
  }
  const enParts: string[] = [];
  enParts.push(`This session was contracted as ${kindEn} work.`);
  enParts.push(
    denied.length
      ? `It agreed not to touch: ${denied.join(", ")}.`
      : "No denied paths were specified.",
  );
  if (s.forbiddenActions.length) enParts.push(`Actions it promised not to take (advisory, not machine-enforced): ${s.forbiddenActions.join(", ")}.`);
  if (s.budget) {
    const b: string[] = [];
    if (s.budget.maxTouchedFiles !== undefined) b.push(`≤${s.budget.maxTouchedFiles} touched files`);
    if (s.budget.maxNewFiles !== undefined) b.push(`≤${s.budget.maxNewFiles} new files`);
    if (b.length) enParts.push(`Change budget: ${b.join(" · ")}.`);
  }
  return { ko: koParts.join(" "), en: enParts.join(" ") };
}
