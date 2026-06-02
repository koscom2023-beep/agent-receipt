# agent-guard — 이 저장소의 작업 규칙

이 디렉터리(`.agent-guard/`)에는 AI 에이전트가 지켜야 할 **작업계약**이 있습니다.

- 계약 파일: `.agent-guard/contract.yaml`
- 스키마 정의(SSOT): agent-guard 의 `CONTRACT.md`

## 에이전트가 지킬 것

1. `contract.yaml` 의 `scope.denied_paths` 에 매칭되는 파일은 변경하지 마세요.
2. `scope.allowed_paths` 가 비어 있지 않다면, 그 글롭에 맞는 파일만 변경하세요.
3. 작업이 끝나면 commit/push 하지 말고 멈추세요(사람이 검토합니다).

## 검사 방법

```
# 변경 상태(브랜치/범위/금지/NUL) 검사 — 명령은 실행하지 않음
agent-guard verify

# required_checks.commands(tsc/test 등) 실행
agent-guard check
```

`--contract` 를 생략하면 `.agent-guard/contract.yaml` 을 자동으로 찾습니다.

## 주의

- `forbidden_actions` 는 **기계적으로 차단되지 않습니다**(권고용 / 프롬프트용). 실제 차단은 `denied_paths` + git 검사 + 사람 검토로 합니다.
- 계약 스키마는 `CONTRACT.md` 가 기준입니다. 스키마에 없는 필드를 추가해도 조용히 무시됩니다.
