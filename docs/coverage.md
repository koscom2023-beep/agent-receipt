# Feature coverage — 3문서 기능 매핑

이 문서는 agent-receipt 의 3개 설계 문서(v0.1 / v0.2 A·B·C / post-v0.2 부록)에 적힌 기능이 현재 어디까지 구현됐는지를 **사실대로** 매핑한다. "전부 개발 완료"라고 선언하지 않는다.

- 기준 버전: **0.6.0 local** (npm latest 는 `0.2.1`, 미publish)
- 현재 상태 판정: **"Promptia dogfood 가능한 v1-core local"** — 개인/Promptia 실사용 범위는 거의 완료, 외주/팀(서명·SaaS 등)은 미착수.
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

## 4. 아직 남은 것 (개인/Promptia 범위 외 또는 미착수)

| 기능 | 상태 | 메모 |
|---|---|---|
| ed25519 서명 receipt | ⬜ | contentHash 는 됨. 서명은 백로그(새 의존성/키 관리 결정 필요) |
| `prompt --cursor` / `--claude` 출력 분기 | ⬜ | 현재 단일 prompt 출력 |
| strict / relaxed preset | ⬜ | 현재 generic/nextjs-supabase/promptia |
| draft-contract | ⬜ | 대화형 계약 초안 생성 미구현 |
| contract review checklist | ⬜ | lint 가 일부 대체하나 체크리스트 산출물은 없음 |
| preset registry 기본 구조 | ⬜ | 현재 preset 은 `templates/` + `init.ts` PRESETS 맵 하드코딩 |
| client receipt template 고급화 | ⬜ | 외주용 고급 템플릿 미구현 |
| 팀 audit history / dashboard / Slack / approval / SaaS | ⛔ | **유료 고객 5~10 신호 전 금지**(v1.0+ 영역) |

---

## 결론

- **개인용 / Promptia 실사용 루프**: `init → mode → start → prompt → run/verify → check → claims → receipt → receipts → explain → reset` 가 하나의 흐름으로 동작한다. 거의 완료권.
- **"3문서 전체"**: 서명 receipt, prompt 출력 분기, strict/relaxed preset, draft-contract, review checklist, preset registry, client template 이 남아 있고, 팀/SaaS 는 수요 전 보류.
- 다음 갈림길: **(a) v1 최종 polish**(위 ⬜ 중 개인용에 도움되는 것) vs **(b) v1+ 외주/팀 기능**(⛔ 해제 신호 후).
