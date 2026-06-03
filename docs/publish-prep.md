# Publish 준비 로그 (npm)

이 문서는 npm publish 준비 과정의 결정·근거·남은 항목을 누적한다. (실제 `npm publish`·login 은 아직 안 함.)

## 결정 (확정)

- **패키지명: `@promptia-labs/agent-receipt`** (scoped).
  - 근거: unscoped `agent-guard` 는 npm 점유됨(`npm view agent-guard` = `1.2.2`, 무관한 패키지 → 탈취 금지). scoped 로 충돌 회피 + 브랜드 자산.
  - **npm 조직 확인됨**: `npm whoami`=`promptia`, org **`promptia-labs`** 존재·`owner` 권한, `@promptia-labs` scope 접근 가능. (초기 후보 `@promptia` 가 아닌 실제 보유 org `@promptia-labs` 로 확정.)
  - 정체성: "AI Work Receipt"(증명/영수증). guard(차단) 오해 감소.
- **CLI 명령(bin): `agent-receipt`** (단일). 기존 `agent-guard`·`ag` bin 제거.
  - `ag` 제거 근거: silver-searcher 등 기존 `ag` 명령과 전역 설치 충돌 위험.
- **scoped public 공개**: `publishConfig.access: "public"` (scoped 는 기본 restricted → 무료 공개시 명시 필요).

## 이번 단계(publish 2단계 경량)에서 한 변경

`package.json`:
- `name` → `@promptia-labs/agent-receipt`
- `private: true` **제거** (private 면 publish 거부)
- `bin` → `{ "agent-receipt": "dist/cli.js" }` (agent-guard·ag 제거)
- `prepack: "npm run build"` 추가 (pack·publish 시 dist 자동 빌드 → tarball 항상 최신)
- `description`, `license`, `engines.node >=18`, `publishConfig.access: public` 추가
- 유지: `version 0.2.0`, `files`(dist/templates/README/CONTRACT), deps, `scripts.build`/`guard`

`README.md`: 제목·설치(`npm install -D @promptia-labs/agent-receipt`)·명령(`agent-receipt …`)·바이너리 줄 반영. `.agent-guard/`(제어 디렉터리)·`agent-guard.yaml`(자동탐색 파일명)·`npm run guard`(dev)는 코드명이라 유지.

**런타임 출력/판정/golden 변화 0** — 패키징·문서 변경만. golden 34케이스 byte-identical 재검증.

## 연기 (실제 publish 전 별도 작업 — 각각 golden/코드 영향)

1. ~~CLI 내부 출력 문자열 정렬~~ → **완료**: `printHelp`(init/start 추가 + agent-receipt), `--contract` 누락 메시지, verify note(`agent-receipt check`), `init.ts` unknown-preset, `output.ts` stale 경고(`agent-receipt start`), `templates/agent-readme.md`(제목·SSOT·verify/check) 를 `agent-receipt` 로 정렬. golden 의도적 갱신(stderr note·new-07·p1a-04·p1b-08·new-04/05 created-README). **유지(미변경)**: 기본 리포트 파일명 `agent-guard-report-<id>.md`(내부 파일명+.gitignore 연동), `.agent-guard/` 디렉터리, `agent-guard.yaml`/`.json` 자동탐색.
2. **제어 디렉터리/자동탐색 파일명**: `.agent-guard/` 와 `agent-guard.yaml`/`agent-guard.json`(discover.ts `DEFAULT_CONTRACT_PATHS`). 브랜드 일치를 위해 `.agent-receipt/`·`agent-receipt.yaml` 로 갈지 = **열린 결정**(breaking + 코드+golden). 현재 유지.
3. ~~LICENSE 결정~~ → **확정: MIT** (오너 결정, 무료 공개 CLI/채택 유도; Promptia 본진 코드와 별개). `license: "MIT"` + `LICENSE` 파일(저작권자 `Promptia`, 2026 — 필요시 법인명 조정) 적용 완료. npm 은 LICENSE 를 tarball 에 자동 포함.
4. **`repository`/`author`/`homepage`**: git remote(origin) 미설정(push 0)이라 URL 없음 → remote 생기면 추가.
5. **실제 `npm publish` + npm login/token**: 미실행. 외부 공개·사실상 영구 → 최종 별도 신중 승인.

## 배포 전 체크리스트

- [x] name scoped 확정 (`@promptia-labs/agent-receipt`)
- [x] `private` 제거 / `publishConfig.access: public`
- [x] bin 단일화(`agent-receipt`), `ag` 제거
- [x] `prepack` 빌드훅
- [x] description/engines
- [x] README 설치·명령 반영
- [x] CLI 출력 문자열 정렬 — `agent-receipt` (golden 갱신 완료)
- [x] LICENSE 확정 — **MIT** (license:MIT + LICENSE 파일)
- [x] scope 확정 — `@promptia-labs/agent-receipt` (org `promptia-labs`, owner 권한 확인)
- [x] **0.2.0 npm publish 완료** (`@promptia-labs/agent-receipt`, public)
- [ ] repository/author (연기 4)
- [ ] (선택) 제어 디렉터리/discover 파일명 리브랜드 결정 (연기 2)

## 릴리스 이력

- **`0.2.0`** — npm 최초 publish 완료 (`@promptia-labs/agent-receipt`, `--access public`).
- **`0.2.1`** — README publish-state 문구 패치: "not yet published to npm / Once published / not final until release" 제거 → 공개 상태 반영. **코드/기능 변경 없음**(문서 + version bump만). golden 무영향.
- **`0.2.2`** — v0.3 usability sprint: `status`/`reset` 명령 신규, stale 경고·start 실패 메시지를 `agent-receipt reset`/`start` 안내로 개선, help 갱신, README/CONTRACT 반영. verify 판정·`--json` 14키 불변. (미publish — 로컬 커밋만.)
- **`0.3.0`** — v1-core sprint: `receipt`(verify+check 결과를 `.agent-guard/receipts/` 에 json/md 저장) · `doctor`(환경 건강 점검) · `lint`(계약 품질 advisory) 신규. verify 가 `.agent-guard/receipts/` 도 제외. README/CONTRACT/help 반영. verify 판정·`--json` 14키 불변. (npm latest 는 여전히 `0.2.1` — 0.2.2/0.3.0 미publish, 로컬 커밋만.)
- **`0.4.0`** — v1-core sprint 2: `claims`(AI 완료보고↔git 대조) · `explain`(왜 PASS/FAIL + 규모/critical + recovery hint) 신규. receipt 에 `magnitude`/`criticalPaths`/`contentHash`(sha256, 내장 crypto) 추가. prompt 강화(scope-밖 중단/추가개선 금지/commit·push·deploy 금지/완료보고 JSON), check exit127 환경문제 구분, 인자없음 단일명령 라우팅. `docs/recipes.md`(worktree/CI/hook) 추가. **계약 스키마·`verify --json` 14키 불변**(사람용 stdout 만 의도적 확장 → golden 갱신). 새 의존성 0. (미publish — 로컬 커밋만.)
- **`0.5.0`** — v1 통합 sprint 3: `promptia` preset(`templates/promptia.yaml` — .env/락파일/supabase migrations/vercel/exports/docs-arch-json denied + 넓은 allowed_paths + 주석 처리한 required_checks) 신규. `run`(인자없음 라우팅 별칭) 추가, router PASS/FAIL 안내 강화(PASS→check·receipt·claims / FAIL→explain·status·reset). `lint`/`doctor` 가 `id: promptia` 감지 시 핵심 denied_paths 누락을 사실로 경고(점수화 없음). `docs/recipes.md` 에 Promptia 일상 루프 recipe 추가. **계약 스키마·`verify --json` 14키 불변**(promptia 는 template 일 뿐 스키마 확장 아님; 사람용 stdout 만 확장 → golden v04-06/08 갱신·v05-01~06 추가). 새 의존성 0, `files` 에 templates 포함 유지(promptia.yaml 자동 동봉). (미publish — 로컬 커밋만.)
- **`0.6.0`** — v1 통합 sprint 4: `mode`(task/daily 작업 흐름 설명, read-only, 저장 파일 없음) · `receipts`(저장 receipt 조회 — 최신순 목록/`--latest`/`--cat`/`--dir`) 신규. `receipt` 출력에 기본위치-밖 저장 안내 + `receipts` 조회 포인터 1줄 추가. `docs/coverage.md` 신규(3문서 기능 매핑 — 현재 "Promptia dogfood 가능한 v1-core local" 판정). README/CONTRACT/recipes 에 mode/receipts·daily 흐름 반영. **계약 스키마·`verify --json` 14키 불변**(둘 다 read-only, 새 저장 스키마 없음, 점수화/자동 revert/AI 진실 간주 없음). golden v1-01~03 갱신(receipt 안내)·v06-01~07 추가. 새 의존성 0. (미publish — 로컬 커밋만.)
- **`0.7.0`** — Sprint 5(remaining v1+ all-in): local-first 로 남은 v1/v1+ 기능 전부 수거. 신규 명령 — `presets`(레지스트리) · `draft-contract`(비대화형 초안) · `review`(commit-전 체크리스트) · `prompt --cursor|--claude`(완료 JSON 동일) · `receipt --format client-md`(고객용 렌더) · `keys init`/`sign`/`verify-signature`(ed25519, Node 내장 crypto, sidecar `.sig.json`) · `audit [--json]`(receipts 집계) · `dashboard`(단일 static HTML) · `approve`/`approvals`(sidecar `.approval.json`) · `export --format slack|json`(stdout dry-run, 전송 없음). 새 preset `strict`/`relaxed`(template 2개). verify tool-output 제외에 `keys/`·`dashboard.html` 추가(`isToolOutput` 단일화). **계약 스키마·`verify --json` 14키 불변**(서명/승인/대시보드/export 는 verify 스키마와 별개). **금지선 유지**: 자동 revert·risk score·AI self-cert·외부 Slack/webhook 전송·원격 SaaS 없음. `docs/coverage.md` 갱신("local-first v1+ 기능 완료, cloud/SaaS/remote 는 제품화 신호 전 보류"). README Quick Start 를 Promptia 루프로 재정렬. golden new-07/08 갱신 + v07-01~20 추가(서명 happy-path 는 비결정적 → smoke/dogfood, golden 은 error path). 새 의존성 0, package-lock 불변. (미publish — 로컬 커밋만.)
- **`0.8.0`** — Sprint 6(AI 작업 감사 프로토콜): 토큰 절감 방향 폐기 → "AI 작업 감사 영수증". 신규 명령 — `begin`/`done`(루프 2명령 단축) · `policy init/check/show`(`.agent-guard/policy.yaml` 상시규칙, 별도 SSOT) · `commit-check`+`trailer`(커밋 직전 게이트, 자동 commit 안 함, `Agent-Receipt/Agent-Contract/Agent-Policy` 트레일러) · `audit-pack`(증거 묶음) · `ledger`(append-only `.agent-guard/ledger.jsonl`, 메타만) · `replay`(별칭 `verify-pack` — contentHash 재계산+commit 존재로 tamper-evident 재검증) · `attest`(in-toto style 초안, SLSA level 단정 없음) · `incident`(사고 조사). 강화 — `explain`(못 보는 것), `report --type developer|client|audit`, `receipt --redact`(best-effort), `export --format github-pr|otel|langfuse`(stdout preview), `help --all`. N8 트립와이어(`allowed:[]` 여도 policy forbid/protect/approval 관찰), receipt 에 `environment`(git/node/os + contract/policy 해시) 추가. `isToolOutput` 제외에 `audit-packs/`·`ledger.jsonl` 추가. **계약 스키마·`verify --json` 14키 불변**(policy/감사 산출은 전부 sidecar — golden s6-06 가드). **금지선 유지**: 자동 revert/commit·점수화·실 전송·원격 SaaS·새 의존성 0, package-lock 불변. 모든 감사/증거 출력에 한계 고지(git 작업트리 기준; .gitignore·레포밖·OS·DB·외부서비스 못 봄; "컴플라이언스 보장" 아님). golden 110 케이스(기존 갱신 + s6-01~22). QA(Sprint 6.5): P0/P1/P2-데드코드 0, fixtures 5/5, Promptia 복제본 dogfood PASS. **npm publish 완료**(`@promptia-labs/agent-receipt@0.8.0`, latest/public) + GitHub push 완료(`koscom2023-beep/agent-receipt`).
- **`0.8.1`** — README-only 정합성 패치(**코드/기능/golden 변경 0**, docs + version bump만). 공개 README 가 0.8.0 실제 기능과 어긋난 문제 수정: 제품명 잔재 "Agent Guard" → `agent-receipt` 통일, Quick Start 를 `begin`/`done` 2명령 루프로 교체, Commands 표에 0.8 감사 명령군(`begin`/`done`/`policy`/`commit-check`/`trailer`/`audit-pack`/`replay`/`ledger`/`attest`/`incident`/`report --type`/`export` 신규 포맷) 추가, tool-output 제외 목록을 실제(`keys`/`audit-packs`/`ledger`/`dashboard`)로 정정, Package status 의 stale 문구(`0.2.1`/`0.7.x local`) 제거 → "latest 0.8.0, 0.8.1 README 패치, 1.0.0 after Promptia 실사용". 한계 고지(git 작업트리 기준·컴플라이언스 보장 아님·AI 보고는 주장) 유지. `.agent-guard/`·`agent-guard.yaml` 자동탐색 경로는 실제 동작이라 의도적 유지. src/test/golden 무변경.
