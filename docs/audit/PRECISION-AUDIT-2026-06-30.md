# 정밀 감사 보고 — agent-receipt (2026-06-30, 13차 council)

> **범위**: "모든 기능이 유기적으로 작동하는가 · 기능상 문제 · 기술부채 · AI부채" (owner 지시)
> **방법**: 20개 에이전트가 4차원(통합·기능버그·기술부채·AI부채)을 병렬 감사 → 각 발견을 **적대적 검증**(거짓 양성 제거)으로 재확인.
> **결과**: 발견 28건 → **확정+고칠가치 9건 수정·배포**(commit `6e61a54`), **7건은 안 고침**(거짓 양성/사소/정체성/보류 — 사유 명시).
> **불변식**: 정상 영수증 출력·골든 143 케이스 불변. 전체 테스트 green. (코드 *품질* 판단은 우리 도구의 범위 밖 — 이 감사는 통합·정합·버그·중복만 다룸.)

---

## A. 수정 완료 (9건 — commit `6e61a54`)

| # | 차원 | 위치 | 문제 | 수정 |
|---|---|---|---|---|
| 1 | bug(med) | `controls.ts`/`shareproof.ts` | 영수증 아닌 JSON(예: `verify --json` 출력)을 `--receipt`로 주면 `r.checks.length` 미방어 → **미처리 TypeError 크래시(exit 1)**. 형제 `risk`만 graceful. | 공용 로더가 게이트에서 **clean exit 2**로 거부 |
| 2 | tech/AI-debt(med) | `controls.ts`·`risk.ts`·`shareproof.ts` | 영수증 적재 블록(경로해석+parse+검증) **~25줄이 3곳에 글자단위 복붙** | `receiptStore.loadSavedReceipt()` SSOT 1개로 통합(ok + checks/criticalPaths/touched 배열 검증) |
| 3 | bug(med) | `anchor.ts:78` | Rekor **409(이미 등록)** 에러바디 `{code,message}`를 201처럼 파싱 → `uuid="code"` **가짜 sidecar** 기록 | `extractRekorUuid()` 순수함수 추출 — 키가 UUID-shape일 때만 신뢰, 아니면 메시지서 추출, 둘 다 실패면 `null`→throw(가짜 증거 안 만듦) |
| 4 | integration(med) | `cli.ts` help | `keys/sign/verify-signature/approve/approvals`가 배선·타 명령이 가리키는데 `help --all` 카탈로그에 **0** | help에 "서명/승인" 섹션 추가 |
| 5 | integration(low) | `incident.ts:36` | `--since` 무효값 → incident는 1건만(insights는 전체) = **사고를 조용히 가림** | `Number()||all.length`(무효→전체)로 insights와 정합 |
| 6 | integration(low) | `attest.ts:80` | `attest`만 인자 없으면 에러(형제 risk/controls/anchor/share-proof는 최신 자동) | 인자 없으면 최신 영수증 폴백 |
| 7 | (위 1/2의 일부) | — | controls/risk/share-proof 적재 정합화 | 공용 로더로 동작 통일(=정합화=수정) |

테스트: `audit-fixes.test.mjs` 5건 신규(`extractRekorUuid` 409·`loadSavedReceipt`). e2e로 "부분 영수증 3명령 clean exit 2 / 정상 exit 0 / 가짜 sidecar 안 씀 / help 노출 / attest 폴백" 확인.

---

## B. 안 고침 — 사유 (7건)

| 판정 | 위치 | 내용 | 안 고친 이유 |
|---|---|---|---|
| **보류(worth=True)** | `capture.ts:306` | **appendCapture 동시쓰기 레이스** — 병렬 tool의 PostToolUse 훅 2개가 같은 prior를 읽으면 동일 seq/prevHash → `capture verify` 오탐 가능 | 진짜 잠재 결함이나 **단일 훅 발화 가정**(보통 직렬)이고, 제대로 고치려면 파일 락(무의존 cross-platform 난해) = 현 단계 과투자. **다음 후보 1순위로 문서화**(아래 C). |
| 거짓전제 | `cli.ts:132` | "controls --redact가 help에 없다(형제는 있다)" | 전제 거짓 — help엔 `--redact` 토큰이 없음(`--strict-redact`만). 형제 비교가 틀려 REJECTED |
| 이미 해결 | `risk.ts:108` | 적재 블록 복붙 | A#2 공용 로더로 이미 제거됨 |
| 사소 | `shareproof.ts:64` | uncovered 계산이 `reconcileCapture`와 중복 | 표면 중복은 실재하나 share-proof는 Receipt(actions)만, capture는 raw records — 입력이 달라 통합 이득 적음·저위험 |
| 사소 | `risk.ts:37` | 임계(3파일/50줄·표시 10)가 명명 상수 아님 | 동작 정상·표시 트리거일 뿐. 명명은 미관 개선(churn) |
| 사소 | `cli.ts:242` | `risk`만 `--redact` 미배선(형제는 있음) | 실재 비일관이나 경미. risk 출력 경로 노출 우려는 있음 → 원하면 후속(아래 C) |
| 무해 | `receiptStore.ts:85` | `hasRekorAnchor` export 미사용 | `hasSignature/hasApproval` 형제 모양·무해. 삭제 이득 미미 |

---

## C. 보류·후속 후보 (owner 결정)
1. **동시쓰기 레이스 방어**(capture.ts) — 파일 락 또는 원자적 append+재시도. 병렬 tool 훅 환경에서 가치. (worth=True·이번엔 단일훅 가정으로 보류)
2. **`risk --redact` 패리티** — 위험 신호 출력의 경로 마스킹(형제 일관성). 경미.
3. 미관: 임계 상수 명명·미사용 export 정리 — churn 대비 이득 작음.

---

## D. 참고 — 이번 세션의 다른 감사/회의
- **기능 30개 4층 실상태 감사**(회계 장부→감사→컨설팅 매핑): 결과는 메모리 `agent-receipt-strategy-state.md` + 커밋 이력. (완전성·노이즈·멀티에이전트·규제매핑·분석 실기능화 확인)
- **회계 프로세스 마이닝(11차)·부채 탐지(12차) 회의**: 산출물 = 대사(reconcileCapture)·증거위계 tier·`risk` 명령(commit `c264919`).
- 이 문서는 그 위에서 돌린 **코드 정밀 감사(13차)** 결과다.

> 한계(정직): 이 감사는 통합·정합·버그·중복을 본다. 코드의 *품질/복잡도/보안패턴*(AST 영역)은 의도적으로 보지 않는다 — 그건 우리 도구 정체성 밖(README "코드 좋은지는 안 봄").
