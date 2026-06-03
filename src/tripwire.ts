import { loadPolicySafe, policyObservations, type PolicyObs } from "./policy.js";
import { touchedFull } from "./evidence.js";

// ── N8 트립와이어 ──
// allowed_paths 가 비어 positive scope 검사가 꺼져도, policy.forbidAlways/protectAlways/requireApprovalFor 는
// 항상 full working tree 변경(touchedFull — denied/critical 과 동일 기준)으로 관찰한다. 차단이 아니라 표시.
// 이 정보는 verify(human)·explain·receipt·commit-check 표면에만 싣고, verify --json 의 14키는 절대 건드리지 않는다.

export interface Tripwire {
  policyPresent: boolean;
  policyError: string | null;
  obs: PolicyObs | null;
}

export function evalTripwire(cwd: string = process.cwd()): Tripwire {
  const { policy, error } = loadPolicySafe(cwd);
  if (error) return { policyPresent: true, policyError: error, obs: null };
  if (!policy) return { policyPresent: false, policyError: null, obs: null };
  return { policyPresent: true, policyError: null, obs: policyObservations(policy, touchedFull()) };
}

// 사람용 표시 라인. policy 없으면 빈 배열(기존 출력 불변 → golden 안전). 형식 오류면 경고 한 줄.
export function tripwireLines(t: Tripwire): string[] {
  if (t.policyError) return [`정책      : ⚠️ policy.yaml 무시됨 — ${t.policyError.split("\n")[0]}`];
  if (!t.policyPresent || !t.obs) return [];
  const o = t.obs;
  const L: string[] = [];
  L.push(
    o.forbidAlwaysHits.length
      ? `상시금지  : ✗ forbidAlways ${o.forbidAlwaysHits.length}건 — ${o.forbidAlwaysHits.join(", ")}`
      : "상시금지  : ✓ forbidAlways 변경 없음",
  );
  if (o.protectAlwaysHits.length) L.push(`보호경로  : ⚠️ protectAlways ${o.protectAlwaysHits.length}건 — ${o.protectAlwaysHits.join(", ")}`);
  if (o.approvalNeededHits.length) L.push(`승인필요  : ⚠️ ${o.approvalNeededHits.length}건 — ${o.approvalNeededHits.join(", ")} (승인 확인은 commit-check)`);
  return L;
}
