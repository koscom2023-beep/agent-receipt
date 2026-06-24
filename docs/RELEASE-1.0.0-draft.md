# agent-receipt 1.0.0 — Release Notes (DRAFT)

> ⚠️ **DRAFT — 아직 publish 전.** 아래 "릴리스 전 체크리스트"를 통과한 뒤 확정합니다.
> 현재 1.0 기능은 `v0.1-verify-check-split` 브랜치에 로컬 구현(커밋 `3661128`·`34d8179`·`4423706`)되어 있고, tsc(build)만 green 입니다. golden 재생성·런타임 실측·`npm publish` 전입니다.

## 한 줄 소개
AI 코딩 에이전트가 당신의 git 작업트리에 **실제로 무엇을 바꿨는지** 기계적으로 증거화하는 **로컬-first** CLI.
**"Hooks prevent. agent-receipt proves."** — 훅/권한은 *막고*, agent-receipt는 *끝난 뒤 git에 실제로 무엇이 남았는지 증명*합니다.
컴플라이언스 "보장"이 아니라 **git 기반 증거 제공**입니다.

## 원칙 (불변)
- **로컬-first · 네트워크 0 · API 키 0 · 계정 0 · 텔레메트리 0.** 모든 게 당신 머신에서만.
- **새 런타임 의존성 0** (Node 내장 `crypto`만).
- `verify --json` 14키 **고정**(CI/도구 호환).
- "컴플라이언스 보장"·"위조불가" 표현 안 함 — **tamper-evident(변조-감지)** 까지만.

## 0.9.x → 1.0.0 — 이번에 추가된 것

### 설치 / 자동화
- **`install-hooks [--force]` / `uninstall-hooks`** — git `pre-commit`·`pre-push`에 `commit-check` 게이트를 한 명령으로 설치/제거. husky·`core.hooksPath` 감지(충돌 거부), 기존 hook 보존, 멱등.
- **`selftest`** — 임시 repo에서 init→verify PASS→denied FAIL→receipt 자가검증. "내 설치가 정상인가"를 5초에 확인.

### 영수증(receipt) 강화
- **`schemaVersion`** — receipt JSON 버전(`"1.0"`). downstream/CI가 안전하게 의존. contentHash 입력엔 미포함(metadata).
- **provenance** — 어떤 **에이전트/모델**이 작업했는지 환경에 기록. **명시값만**(`--agent`/`--model` 또는 `AGENT_RECEIPT_AGENT`/`AGENT_RECEIPT_MODEL`), 자동 추측 0.
- **`--content`** — touched 파일의 **sha256만** 기록(내용 저장 0), 5MB cap. 경로뿐 아니라 내용 변경까지 증거화.
- **`--strict-redact`** — 강한 비밀(sk-/ghp_/AKIA/xox/Bearer) 감지 시 **receipt 저장 거부**. 엔트로피 스캔 안 함(해시 오탐 방지).

### 감사 / 조회
- **해시체인 ledger + `ledger verify`** — `prevHash`/`entryHash` 체인으로 원장 라인의 **변조·삭제·재정렬 탐지**(네트워크 0). 레거시 flat 라인 호환.
- **dashboard 타임라인** — PASS/FAIL 색칠(오래된→최신) + pass-rate. 인라인만(CDN 0), 최근 500 cap.
- **`index [--json]`** — `receipts/*.json` 요약을 `receipts/index.jsonl`로 재생성(빠른 조회/외부도구용 파생물).
- **`gen-claim --transcript <jsonl>`** (experimental) — 에이전트 transcript의 편집 기록 → `claim.json` 초안. 이후 `claims`로 git 실측과 대조. git 검증 아님(self-report 보조).

## 전체 명령 한눈에
- **핵심 루프**: `begin` → (에이전트 작업) → `done` → `commit-check` → (사람이 커밋) → `audit-pack` → `reset`
- **검증(git 실측)**: `verify [--json]` / `check` / `claims --file` / `explain`
- **영수증/감사**: `receipt` / `receipts` / `report` / `audit` / `dashboard` / `index` / `ledger (verify|rebuild)` / `replay` / `attest` / `incident`
- **무결성**: `keys init` / `sign` / `verify-signature` / `approve` / `approvals`
- **계약/정책**: `presets` / `init` / `draft-contract` / `policy (init|check|show)` / `lint` / `doctor` / `review`
- **설치/자가검증**: `install-hooks` / `uninstall-hooks` / `selftest`
- **연동(experimental, 전송 없음)**: `export` / `gen-claim`
- 전체: `agent-receipt help --all`

## 한계 (Scope of evidence — 정직)
git 작업트리 기준입니다. 다음은 **못 봅니다**: `.gitignore`된 파일, 레포 밖 파일, OS 명령, DB 쓰기, 외부 서비스 변경, **코드 품질/취약점**. AI의 완료 보고는 항상 *주장*이며, 측정되는 건 git 상태뿐입니다.

## 마이그레이션 / 호환
- 기존 영수증과 **호환**: 신규 필드는 contentHash 입력에서 제외/조건부 → 같은 git 상태면 **같은 contentHash**, `replay`도 동일하게 재검증됩니다. 모든 추가는 additive.

## 릴리스 전 체크리스트 (owner)
- [ ] `npm run build` green
- [ ] golden 재생성: `v07-17`(dashboard html) + receipt-출력 14개(`s6-13`/`v1-01~03`/`receipts-cat`/`export*`/`report-audit` 등) → `npx tsx test/run-fixtures.ts` **144 green**
- [ ] 런타임 실측: `selftest` · `ledger verify` · `receipt --content` · `receipt --strict-redact` · `index` · `gen-claim` · `install-hooks`/`uninstall-hooks`
- [ ] `doctor` · `--version` 확인
- [ ] `npm publish` → `npm i -g @promptia-labs/agent-receipt@latest` → promptia에서 1주 dogfood

## 버전 사다리
`0.7.0`(작업 영수증) → `0.8.0`(AI 작업 감사 프로토콜) → `0.9.x`(편의 + dogfood 수정) → **`1.0.0`(안정 — 실사용 검증 후)**
