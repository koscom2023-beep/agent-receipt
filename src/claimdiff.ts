// ── Claim ↔ Git 대조 SSOT (D3) ──
// AI 완료보고(claim)의 파일 목록과 git 실측을 대조하는 단일 규칙.
// 이전엔 claims.ts(compareSet)와 auditpack.ts(claimVerify)가 같은 대조를 각자 구현했고,
// 경로 정규화가 서로 달랐다(claims=백슬래시 통일 O / auditpack=X → Windows claim 거짓 불일치).
// 여기로 통합해 규칙을 하나로 고정한다(claims.ts 의 정답 규칙 채택).

// 경로 정규화: 선행 "./" 제거 + Windows 백슬래시 → forward-slash(git 은 항상 forward-slash).
export function normalizeClaimPath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

// 문자열 배열(비문자열/비배열 방어) → 정규화된 경로 Set.
export function claimPathSet(arr: unknown): Set<string> {
  return new Set(
    Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").map(normalizeClaimPath) : [],
  );
}

export interface ClaimFieldDiff {
  hidden: string[]; // git 에 있는데 AI 가 주장 안 함(숨긴 변경)
  extra: string[]; // AI 가 주장했는데 git 에 없음
  ok: boolean;
}

// AI 주장(aiRaw) ↔ git 실측(gitArr) 한 필드 대조. 양쪽 동일 정규화 규칙 적용.
export function diffClaimField(aiRaw: unknown, gitArr: string[]): ClaimFieldDiff {
  const ai = claimPathSet(aiRaw);
  const git = claimPathSet(gitArr);
  const hidden = [...git].filter((x) => !ai.has(x)).sort();
  const extra = [...ai].filter((x) => !git.has(x)).sort();
  return { hidden, extra, ok: hidden.length === 0 && extra.length === 0 };
}
