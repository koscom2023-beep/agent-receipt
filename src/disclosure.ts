// ── 정체성 가드: 한계 고지(단일 출처) ──
// 모든 감사/증거 출력(verify human·explain·receipt·audit-pack·attest·replay·incident·commit-check)에
// 이 한 줄을 박는다. 정체성 = "git 이 유일한 진실". 이 고지가 없으면 "git 이 못 보는 것까지 본다"는
// 오해로 도구 신뢰가 붕괴한다. "컴플라이언스 보장"이 아니라 "git 증거 제공"이다.
export const LIMIT_NOTE =
  "이 도구는 git 작업트리 기준입니다 — .gitignore된 파일·레포 밖·OS 명령·DB write·외부 서비스 변경은 직접 볼 수 없습니다.";

// AI 완료보고는 영원히 "주장"이고 git 상태만 "실측"이다(claims/attest/report 가 둘을 시각 분리).
export const CLAIM_NOTE = "AI 완료보고는 '주장'이며 git 실측과 다르면 mismatch 로 잡힙니다.";
