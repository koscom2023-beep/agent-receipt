# Feature coverage — 3문서 기능 매핑

이 문서는 agent-receipt 의 3개 설계 문서(v0.1 / v0.2 A·B·C / post-v0.2 부록)에 적힌 기능이 현재 어디까지 구현됐는지를 **사실대로** 매핑한다. "전부 개발 완료"라고 선언하지 않는다.

- 기준 버전: **0.7.0 local** (npm latest 는 `0.2.1`, 미publish)
- 현재 상태 판정: **"local-first v1+ candidate"** — local CLI 로 구현 가능한 v1/v1+ 기능은 전부 완료. cloud/SaaS/remote collaboration 은 제품화 신호 전 보류(§4).
- 범례: ✅ 완료 · 🟡 부분 · ⬜ 남음 · ⛔ 수요 전 보류(유료 고객 5~10 신호 전 금지)

---

## 1. v0.1 문서 — verify/check 분리

v0.1 은 최종 범위를 **2개**로 못박았다(로그 전용 기능·`git diff -M` 은 보류).

| 기능 | 상태 | 비고 |
|---|---|---|
| verify / check 책임 분리 | ✅ | `verify`=상태검사(명령 실행 안 함), `check`=`required_checks.commands` 실행 |
| `verify --json` 안정 스키마 | ✅ | **정확히 14키 동결**(`test/run-fixtures.ts` SPEC_KEYS 단언 + golden) |
| 로그 전용(log-only) 기능 | ⬜ | v0.1 에서 명시적 보류 |
| `git diff -M`(rename 추적) | ⬜ | v0.1 에서 명시적 보류 |

## 2. v0.2 문서 — A/B/C

| 기능 | 상태 | 명령/근거 |
|---|---|---|
| npm 패키징(scoped, bin 단일화, prepack) | ✅ | `@promptia-labs/agent-receipt`, bin `agent-receipt` |
| `init` 스캐폴딩(덮어쓰기 금지) | ✅ | `init --preset <generic\|nextjs-supabase\|promptia>` |
| `start` baseline / baseline-relative verify | ✅ | `start` → `.agent-guard/session.json`, stale 시 안전 degrade |
| `receipt`(AI Work Receipt 저장) | ✅ | `receipt [--format json\|md] [--out]` |
| `doctor`(환경 건강 점검) | ✅ | git/계약/baseline + promptia preset 감지 |
| 친절한 실패 메시지 | ✅ | stale 경고·start 실패·recovery hint |
| 단일명령 라우팅 | ✅ | 인자없음 / `run` 별칭 (PASS→check·receipt·claims / FAIL→explain·status·reset) |
| `prompt` 개선 | ✅ | scope-밖 중단·추가개선 금지·commit/push/deploy 금지·완료보고 JSON |
| `check` exit127 환경문제 구분 | ✅ | exit 127 = command not found / 환경 문제(표시만, exit 규칙 불변) |
| `status` / `reset` | ✅ | read-only 상태 요약 / baseline 제거 |

## 3. post-v0.2 부록 — 우선순위 기능

| 기능 | 상태 | 명령/근거 |
|---|---|---|
| Critical Path Attestation | ✅ | 코드 상수 글롭, receipt/explain 에 touched 표시(차단 아님) |
| Contract lint | ✅ | `lint` + promptia 감지 denied 누락 경고(점수화 없음) |
| Change Magnitude | ✅ | git numstat 숫자만(판단 없음), receipt/explain |
| Recovery hints | ✅ | verify(사람)/explain FAIL 시 카테고리별 — **자동 revert 없음** |
| Prompt hardening | ✅ | 위 prompt 개선 |
| Completion claim verifier | ✅ | `claims --file` — AI 주장 ↔ git 실측("AI said / Git says"), AI 진실 간주 안 함 |
| Receipt contentHash(무결성) | ✅ | sha256(내장 crypto), timestamp 제외 → 결정론적 |
| worktree / CI / hook recipe | ✅ | `docs/recipes.md` |
| **mode**(task/daily 흐름 설명) | ✅ | `mode` — read-only, 저장 파일 없음 (v0.6 신규) |
| **receipts**(저장 receipt 조회) | ✅ | `receipts [--latest\|--cat\|--dir]` (v0.6 신규) |
| promptia preset | ✅ | `init --preset promptia` (v0.5 신규, dogfood 검증) |
| **prompt 변종** (cursor/claude) | ✅ | `prompt --cursor\|--claude` — 완료보고 JSON 동일 (v0.7) |
| **strict / relaxed preset** | ✅ | `templates/strict.yaml`·`relaxed.yaml` + `presets` (v0.7) |
| **draft-contract** | ✅ | `draft-contract` — 비대화형, repo 스캔/preset, stdout/`--out` (v0.7) |
| **contract review checklist** | ✅ | `review` — commit 전 사람 체크리스트(lint 와 별개) (v0.7) |
| **preset registry** | ✅ | `presets` — local builtin 레지스트리(`src/presets.ts` 단일 출처) (v0.7) |
| **client receipt template** | ✅ | `receipt --format client-md` — 고객용 축약 렌더(스키마 동일) (v0.7) |
| **ed25519 서명 receipt** | ✅ | `keys init`/`sign`/`verify-signature` — Node 내장 crypto, sidecar `.sig.json` (v0.7) |
| **local audit history** | ✅ | `audit [--json]` — receipts 집계(자동 append 없음) (v0.7) |
| **local static dashboard** | ✅ | `dashboard` — 단일 self-contained HTML(외부 CDN/network 없음) (v0.7) |
| **local approval workflow** | ✅ | `approve`/`approvals` — sidecar `.approval.json`, git commit/network 없음 (v0.7) |
| **export (slack/json) dry-run** | ✅ | `export --format slack\|json` — stdout 미리보기만(전송 없음) (v0.7) |

## 4. 남은 것 — cloud / remote 전용 (제품화 신호 전 보류)

Sprint 5(v0.7) 로 **local-first 로 구현 가능한 v1/v1+ 기능은 전부 수거**됐다. 남는 것은 본질적으로 외부 서버/원격 협업이 필요한 부분뿐이며, 유료 고객 5~10 신호 전까지 의도적으로 보류한다(허위로 "완료"라고 적지 않는다).

| 기능 | 상태 | 보류 이유 |
|---|---|---|
| 외부 SaaS 서버(중앙 저장/조회) | ⛔ | 서버 인프라·인증 필요. local audit/dashboard 로 대체 중. |
| 실제 Slack 전송 / webhook POST | ⛔ | 토큰/URL·네트워크 전송 필요. `export` 가 payload 미리보기까지만 함(전송 없음). |
| 유료 팀 dashboard(원격) | ⛔ | 호스팅·멀티유저 필요. 로컬 단일 HTML(`dashboard`)로 대체 중. |
| 원격 approval workflow | ⛔ | 원격 상태/알림 필요. 로컬 sidecar(`approve`/`approvals`)로 대체 중. |

> **표현 원칙**: "local-first v1+ 기능 완료" 는 맞다. "외부 SaaS/원격 협업까지 완료" 는 **아니다** — 위 4개는 미구현(보류)이다.

---

## 결론

- **local-first v1+ 기능 완료.** 일상 루프 `presets → init → draft-contract/review → lint → doctor → mode → start → prompt(--cursor/--claude) → run/verify → check → claims → receipt → receipts → sign/verify-signature → audit → dashboard → approve → export(dry-run) → reset` 가 하나의 제품 흐름으로 이어진다.
- **남은 것은 cloud/SaaS/remote collaboration 뿐**이며 제품화 신호 전 보류(§4). 그 외 3문서·부록 기능은 모두 ✅/🟡(로컬판).
- 현재 상태 판정: **"local-first v1+ candidate"** — Promptia 실사용에 바로 투입 가능. 다음은 v1 최종 품질검사 + Promptia 본진 적용 승인.
