# AI 코딩 에이전트 작업 보고 검증 (이 저장소 실제 git 이력 대조)

<!--
  시나리오: AI 코딩 에이전트(Cursor / Claude Code / Copilot)가 "내가 이 커밋으로 이 파일들을
  바꿨다"고 보고했다. 사람이 매번 git 이력을 대조하는 대신, agent-receipt 가 그 보고를
  실제 git 이력과 결정론으로 대조한다. 거짓·과장·환각 보고는 커밋 전에 exit 1 로 반려한다.
  아래 주장의 커밋 해시·파일 경로는 이 저장소의 실측값이다(발명 0).
-->

- statement: 커밋 0310ec1 이 이 저장소에 실재한다
  statedCommit: 0310ec1

- statement: 커밋 0310ec1 이 examples/audit-journal-entry/entries.md 를 변경했다
  statedCommit: 0310ec1
  statedChangedFile: examples/audit-journal-entry/entries.md

- statement: 커밋 0310ec1 의 diff 에 "대차평균" 이 포함된다
  statedCommit: 0310ec1
  statedChangedFile: examples/audit-journal-entry/entries.md
  statedDiffText: 대차평균

- statement: (거짓 보고) 커밋 0310ec1 이 src/capture.ts 를 수정했다 — 실제로는 안 건드림(범위 위반)
  statedCommit: 0310ec1
  statedChangedFile: src/capture.ts

- statement: (환각 보고) 커밋 deadbeefdeadbeefdeadbeefdeadbeefdeadbeef 이 실재한다
  statedCommit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
