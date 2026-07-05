# AI 자동생성 분개 검증 (2026년 6월 결산)

<!--
  시나리오: AI 에이전트가 증빙을 읽고 분개(仕訳)를 자동 생성했다.
  사람이 전표를 한 장씩 다시 검산하는 대신, agent-receipt 가 결정론 검사로
  ① 대차평균(차변합계=대변합계) ② 합계 재계산 ③ 근거(증빙 인용)를 대조한다.
  정상 분개는 통과, 불균형·날조 근거는 그 자리에서 실패(exit 1)한다.
  주장에 쓰인 값은 전부 아래 분개장/증빙에서 온 실측치다(발명 0).
-->

- statement: 분개1 (상품 매출) — 대차평균: 차변합계 − 대변합계 = 0
  op: diff
  operands: 1100000, 1100000
  statedValue: 0

- statement: 분개1 (상품 매출) — 대변 합계 검산: 매출 1,000,000 + 부가세예수금 100,000 = 1,100,000
  op: sum
  operands: 1000000, 100000
  statedValue: 1100000

- statement: 분개2 (급여 지급) — 대차평균: 차변합계 − 대변합계 = 0
  op: diff
  operands: 3000000, 3000000
  statedValue: 0

- statement: 분개3 (비품 구입) — 대차평균: 차변합계 − 대변합계 = 0
  op: diff
  operands: 500000, 450000
  statedValue: 0

- statement: 분개4 (지급수수료) — 근거: 컨설팅 계약서상 월 보수액
  quotedText: 월 2,000,000원
  sourceFile: examples/audit-journal-entry/source-evidence.md
