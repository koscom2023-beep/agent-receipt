# 세션 판정 (Session Verdict) — 규칙 명문 (v0.18)

> **판정은 카테고리 게이트이지 점수가 아니다.** 숫자 점수·등급 평균·0~100 없음. 기존 신호(verify·checks·policy·capture·확인신호·session 상태)의 순수 롤업이며, 각 판정은 항목별 사실(reasons)로 뒷받침되고 그것을 대체하지 않는다.
>
> 코드 SSOT: `src/verdict.ts` 의 `VERDICT_RULES` — 이 문서는 그 표의 서술이다(id 일치를 테스트가 대조).

## 4값과 우선순위 (결정론)

`FAIL ❌ > INCOMPLETE ◌ > PASS_WITH_WARNINGS ⚠️ > PASS ✅`

같은 영수증에 여러 신호가 있으면 항상 위 서열의 **가장 심각한 하나**가 판정이 된다. reason 은 `[rule-id] 사실` 형식(PASS 만 id 없음 — 발동 규칙 0).

## FAIL — 원천은 계약/검사 위반뿐

| rule id | 발동 조건 |
|---------|-----------|
| `denied-path` | 계약 denied_paths 에 매치되는 변경이 있음 |
| `out-of-scope` | 계약 allowed_paths 밖 변경이 있음(allowed 지정 시) |
| `check-failed` | 계약 checks 명령이 요구 exit 와 다르게 끝남 |
| `verify-fail` | 그 외 verify 위반(violations 항목) |

## INCOMPLETE — 위반은 없으나 측정 기반 불완전 (사유 코드 + 고치는 법)

| rule id | 발동 조건 | 고치는 법 |
|---------|-----------|-----------|
| `no-baseline` | begin 미실행 — 세션 baseline 없음(전체 트리 측정만 수행) | 작업 시작 전 `agent-receipt begin --kind <kind>` |
| `stale-branch-mismatch` | begin 때와 다른 브랜치에서 측정됨 | begin 한 브랜치로 복귀, 또는 현 브랜치에서 `begin` 재실행 |
| `stale-baseline-not-ancestor` | baseline 커밋이 현재 HEAD 의 조상이 아님(rebase/reset/amend 흔적) | `begin` 재실행(현재 HEAD 로 새 baseline) |
| `stale-unknown` | baseline 미적용(기타·사유 미기록) | `begin` 재실행 |

고치는 법은 **고정 매핑**(LLM 추천 아님) — reason 줄에 `· 고치는 법:` 으로 병기된다.

## PASS_WITH_WARNINGS — 통과했으나 사람이 봐야 할 신호

| rule id | 발동 조건 |
|---------|-----------|
| `critical-path` | 계약 critical_paths 에 매치되는 변경이 있음 |
| `policy-forbid` | policy forbidAlways 에 매치되는 변경이 있음 |
| `waste-signal` | capture 에 가드 경고/차단·반복 낭비 신호가 있음 |
| `red-flag` | 확인 신호 — 추가된 줄의 test .only/.skip 또는 의존성 추가 |

**🔴 승격 없음(명문)**: WARN(PASS_WITH_WARNINGS)은 FAIL 로 자동 승격되지 않는다 — FAIL 의 원천은 계약/검사 위반(verify FAIL)뿐. 승격은 사람 판단이며, 원하면 policy `fail_on_done` 으로 **exit 게이트만** opt-in 할 수 있다(판정 자체는 불변).

## policy `fail_on_done` — exit 게이트 opt-in (v0.18)

`.agent-guard/policy.yaml`:

```yaml
fail_on_done: incomplete   # fail | incomplete | warn
```

| 값 | done 이 exit 1 이 되는 판정 |
|----|------------------------------|
| `fail` | FAIL (현행과 동일 — 명시용) |
| `incomplete` | FAIL, INCOMPLETE |
| `warn` | FAIL, INCOMPLETE, PASS_WITH_WARNINGS |

- 미설정 = 현행 그대로(receipt.ok 만 exit 에 반영). **판정·출력은 어떤 값에서도 불변** — exit 코드만 올라가며, 발동 시 done 이 원인을 1줄 자백한다.
- ⚠ `warn` 임계는 고위험 경로(critical_paths)를 일상적으로 만지는 repo 에 **비권장** — 매번 exit 1 이 되어 알람 피로를 만든다(악마의 대변자 지적·기록).

## 경계 (정직)

- 판정은 **git 작업트리 기준 증거의 롤업**이다 — .gitignore·레포 밖·OS·DB·외부 서비스는 보지 못한다.
- PASS 는 "계약 준수 + 검사 통과 + 경고 신호 없음"이지 **작업이 옳다/좋다의 보증이 아니다**.
- reason 의 `[rule-id]` 는 기계 판독용 접두다(`^\[([a-z-]+)\]`) — id 목록·의미는 이 문서와 `VERDICT_RULES` 가 SSOT.
