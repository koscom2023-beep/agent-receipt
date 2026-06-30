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
1. ~~동시쓰기 레이스 방어(capture.ts)~~ → **2차 심층감사(14차)에서 해결됨**(아래 E).
2. **`risk --redact` 패리티** — 위험 신호 출력의 경로 마스킹(형제 일관성). 경미.
3. 미관: 임계 상수 명명·미사용 export 정리 — churn 대비 이득 작음.

---

## D. 참고 — 이번 세션의 다른 감사/회의
- **기능 30개 4층 실상태 감사**(회계 장부→감사→컨설팅 매핑): 결과는 메모리 `agent-receipt-strategy-state.md` + 커밋 이력. (완전성·노이즈·멀티에이전트·규제매핑·분석 실기능화 확인)
- **회계 프로세스 마이닝(11차)·부채 탐지(12차) 회의**: 산출물 = 대사(reconcileCapture)·증거위계 tier·`risk` 명령(commit `c264919`).
- 이 문서는 그 위에서 돌린 **코드 정밀 감사(13차)** 결과다.

---

## E. 2차 심층 감사 (14차 council·"무결점 추구"·commit `38791b0`)
owner "무결점" 지시 → 첫 감사가 덜 판 **프런티어**(동시성·내 수정 회귀·엣지/불변식)를 13에이전트로 재감사 + 적대적 검증. 확정 8건 전부 수정:

| # | 차원 | 위치 | 결함 | 수정 |
|---|---|---|---|---|
| 1 | **invariant(high)** | `keys.ts` | **개인키 데이터 손실** — `ensureSigningKey` 가드가 `!priv \|\| !pub`라, public.pem만 지워도 개인키를 *재생성·덮어쓰기* → 과거 서명·Rekor 앵커 전부 무효·옛 키 영구 소실(무경고) | priv 있으면 **재생성 금지**, pub는 `createPublicKey(priv)`로 유도. 신규=atomic(0o600). 메모리 키쌍 반환 |
| 2 | concurrency(high) | `capture.ts` | appendCapture 무락 → 병렬 훅 2개가 같은 tail 읽어 **포크**(중복 seq·같은 prevHash) → `verify`가 정직한 로그를 *변조/누락으로 오탐*(tamper 도구가 늑대 외침) | `withFileLock`로 read→append→writeHead 직렬화. 락 실패=degraded 마커 |
| 3 | concurrency(med) | `keys.ts` | 동시 anchor 시 priv/pub **불일치 쌍** 서명 → 깨진 봉인을 '✅ 성공' 보고 | 락 + 메모리 키쌍 반환(디스크 재읽기 제거) |
| 4 | concurrency(med) | `ledger.ts` | appendLedger 동일 무락 포크 | `withFileLock` 직렬화 |
| 5 | edge(low) | `ledger.ts`/index | 전체 덮어쓰기 'w' truncate → 인터럽트 시 부분파일 | `writeFileAtomic`(temp+rename) |
| 6·7·8 | loader-safety/invariant(med) | `receiptStore.ts` | 공용 로더가 `criticalPaths[].touched`·`branch.current`·`magnitude`·`staged/untracked/deniedHits` 미검증 → 형제(controls/risk/share-proof)가 게이트 통과 후 deref 크래시 | `loadSavedReceipt`가 consumer deref 필드 *전부* 검증→clean exit 2(정상 영수증 불변) |

신규: `src/lock.ts`(stdlib·의존성0 — `withFileLock` O_EXCL+Atomics.wait 백오프+stale 강탈·`writeFileAtomic`). 테스트 `lock-keys.test.mjs` 7(원자쓰기·재진입 차단·stale 강탈·**개인키 보존**·매칭쌍).
제외(2차): anchor 409 Location 헤더(바디 추출 충분)·로더가 risk 좁힘(의도된 정합).

> **"무결점"에 대한 정직**: 이 2라운드로 *알려진 진짜 결함을 0*으로 만들고 더 깊이 팠다. 그러나 **완전 무결점은 *선언*하지 않는다** — '결함 없음'의 양성 증명은 원리적으로 불가(우리 도구가 capture 완전성에 대해 스스로 인정하는 바로 그 한계). 무결점은 *추구*하되 *단정*하지 않는다.

> 한계(정직): 이 감사는 통합·정합·버그·중복을 본다. 코드의 *품질/복잡도/보안패턴*(AST 영역)은 의도적으로 보지 않는다 — 그건 우리 도구 정체성 밖(README "코드 좋은지는 안 봄").
