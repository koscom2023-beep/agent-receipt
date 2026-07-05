# RAG 답변 근거 검증 (답변의 각 주장이 검색 컨텍스트에 실재하나)

<!--
  시나리오: RAG 시스템이 검색한 passages(retrieved-context.md)를 바탕으로 답변을 생성했다.
  답변의 각 핵심 주장을 그 컨텍스트와 결정론으로 대조한다(인용 충실성·grounding/faithfulness).
  컨텍스트에 없는 문장은 환각(hallucination)으로 not-found 처리한다.
  아래 quotedText 는 답변에서 뽑은 문장이고, sourceFile 은 검색 컨텍스트다.
-->

- statement: (근거 있음) 답변 — SOC 2 Type I 감사를 2026년 3월에 완료
  quotedText: completed a SOC 2 Type I audit in March 2026
  sourceFile: examples/rag-grounding/retrieved-context.md

- statement: (근거 있음) 답변 — 데이터센터는 서울과 도쿄
  quotedText: data centers in Seoul and Tokyo
  sourceFile: examples/rag-grounding/retrieved-context.md

- statement: (환각) 답변 — SOC 2 Type II 감사를 통과했다
  quotedText: has passed a SOC 2 Type II audit
  sourceFile: examples/rag-grounding/retrieved-context.md

- statement: (환각) 답변 — 직원 500명
  quotedText: 500 employees
  sourceFile: examples/rag-grounding/retrieved-context.md
