# Feature coverage — 3문서 기능 매핑

이 문서는 agent-receipt 의 3개 설계 문서(v0.1 / v0.2 A·B·C / post-v0.2 부록)에 적힌 기능이 현재 어디까지 구현됐는지를 **사실대로** 매핑한다. "전부 개발 완료"라고 선언하지 않는다.

- 기준 버전: **0.8.0 local** (npm latest 는 `0.7.0` — 0.8.0 은 미publish, Sprint 6)
- 현재 상태 판정: **"local-first AI 작업 감사 프로토콜 후보"** — 토큰 절감기가 아니라, AI 코딩 작업을 git 기준으로 검증하고 **감사 가능한 증거**를 남기는 로컬 도구. cloud/SaaS/실제 Slack 전송/원격 approval/법적 보증은 보류(§4).
- 범례: ✅ 완료 · 🟡 부분 · ⬜ 남음 · ⛔ 수요 전 보류(유료 고객 5~10 신호 전 금지)
- **정체성 가드(절대)**: 이 도구는 git 작업트리 기준이다 — .gitignore·레포 밖·OS·DB·외부 서비스는 직접 못 본다. "컴플라이언스 **보장**"이 아니라 "컴플라이언스 검토용 git **증거 제공**"이다. AI 완료보고는 영원히 "주장", git 상태만 "실측". 점수화·자동 revert·자동 commit·실 전송·원격 SaaS 금지.

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

## 3.5. Sprint 6 (v0.8) — AI 작업 감사 프로토콜 통합 스프린트

토큰 절감 방향을 폐기하고 **AI 작업 감사 프로토콜**로 진화. 모든 감사/증거 출력에 한계 고지를 박는다.

| 기능 | 상태 | 명령/근거 |
|---|---|---|
| **begin / done** | ✅ | 실사용 루프 단축 — `begin [--cursor\|--claude]`(policy+baseline+prompt) / `done [--claim][--client][--ledger]`(verify+check+receipt+요약) |
| **help 단순화** | ✅ | 기본 help=begin/done/commit-check/audit-pack/explain, 전체=`help --all`. 기존 명령 제거 안 함 |
| **policy.yaml** | ✅ | `policy init [--profile solo-founder\|vibe-coder\|agency-client\|team-strict\|promptia] / check / show`. contract=작업범위, policy=상시규칙(별도 SSOT) |
| **N8 트립와이어** | ✅ | `allowed_paths:[]` 여도 forbidAlways/protectAlways/approvalFor 상시 관찰 → verify(human)/explain/receipt/commit-check. **verify --json 14키 불변** |
| **commit-check / trailer** | ✅ | 커밋 직전 게이트(자동 commit 안 함) + `Agent-Receipt/Agent-Contract/Agent-Policy` 트레일러(값/diff 없이 해시만) |
| **audit-pack** | ✅ | `audit-pack [--out][--claim][--redact][--ledger]` — contract/policy/receipt/claim/claim-verify/approval/signature/environment/manifest 묶음. "위조불가" 호칭 금지 |
| **environment 캡처** | ✅ | receipt+audit-pack 에 git/node/npm/os + contractHash/policyHash. **AI 모델명 자동감지 안 함** |
| **ledger.jsonl** | ✅ | `ledger [--json] / ledger rebuild`. 자동 append 기본 OFF. 1줄=메타만(내용/diff 금지). flat 파일까지만(대시보드/SaaS 금지) |
| **replay / verify-pack** | ✅ | `replay --pack <dir>` — contentHash 재계산·headHash 존재로 tamper-evident 재검증. 외부 DB/OS 재현불가 명시 |
| **attest (in-toto style)** | ✅ | `attest --receipt\|--pack` — in-toto Statement 스타일 초안. SLSA level/위조불가 단정 금지(tamper-evident 까지) |
| **redact** | ✅ | `receipt/audit-pack --redact` — best-effort 민감값 가림(완벽 탐지 주장 금지) |
| **incident** | ✅ | `incident [--since n]` — 실패·위험변경·승인누락·마지막 PASS 요약. 자동복구·점수화 없음 |
| **report --type** | ✅ | `report --type developer\|client\|audit` — 기존 호환(default=developer) |
| **export 확장** | ✅ | `export --format github-pr\|otel\|langfuse` — stdout payload preview, **전송 없음** |
| **explain 강화** | ✅ | 무엇/왜/선택지/**못 보는 것** + policy tripwire + stale session |
| GitHub Action 자동 PR 댓글 | ⛔ | 게이트 레시피 문서는 OK, 자동 댓글은 수요 신호 후 |
| git notes / shareable policy 패키지 | ⛔ | 보류(트레일러·로컬 policy 로 충분) |

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

- **local-first AI 작업 감사 프로토콜 후보.** 감사 흐름 `begin → (작업) → done → explain(실패 시) → audit-pack → attest → 트레일러로 커밋 → ledger 적립 → 나중에 replay 재검증 / 사고 시 incident` 가 하나로 이어진다(commit-check 가 커밋 직전 게이트).
- **남은 것은 cloud/SaaS/실제 전송/원격 협업/자동 PR 댓글 뿐**이며 제품화 신호 전 보류(§4·§3.5). "외부 SaaS/원격까지 완료"는 아니다.
- 현재 상태 판정: **"local-first AI 작업 감사 프로토콜 후보(0.8.0)"**. 버전 사다리: 0.7.0(작업 영수증) → **0.8.0(감사 프로토콜 후보)** → 1.0.0(Promptia 실사용 후 안정판). 다음은 Promptia 1주 실사용 → 불편 수정 → 1.0.0. **컴플라이언스 "보장" 표현 금지.**
