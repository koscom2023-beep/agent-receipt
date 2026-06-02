# agent-guard — 작업계약 스키마 (CONTRACT)

이 문서는 agent-guard 가 읽는 **작업계약(contract) 파일의 스키마를 동결**한다.

- **SSOT 는 `src/schema.ts`** 다. 이 문서가 코드와 어긋나면 **코드(`src/schema.ts`)가 맞다.** 이 문서를 고쳐라.
- 여기 적힌 내용은 v0.1 (branch `v0.1-verify-check-split`, HEAD `94b5271`) 의 실제 동작이며, **Slice A / v0.2 동안 변경하지 않는다**(아래 §11 동결 선언).
- 예시 값이 아니라 **실제 zod 스키마 기준**으로 작성됐다. 다른 문서의 예시 값과 다르면 이 문서/코드가 우선이다.

---

## 1. 파일 형식 — YAML 과 JSON 은 같은 스키마로 파싱된다

`loadContract(path)` 는 파일을 읽어 `yaml.parse()` 로 파싱한 뒤 **하나의 zod 스키마**(`ContractSchema`)로 검증한다.

- **JSON 은 YAML 의 부분집합**이므로 `.json` 계약도 같은 `yaml.parse()` 가 그대로 파싱한다.
- 따라서 **`.yaml` 과 `.json` 은 동일한 스키마·동일한 기본값·동일한 검증**을 받는다. 확장자는 자유다.
- 파싱 실패(파일 없음 / 스키마 위반)는 CLI 에서 **exit 2** 로 끝난다(§9, §10).

---

## 2. 최상위 필드

| 필드 | 타입 | 필수? | 기본값 | 비고 |
|---|---|---|---|---|
| `id` | string | **필수** | — | 계약 식별자 |
| `title` | string | optional | (없음 → JSON 출력 시 `null`) | 사람용 제목 |
| `mode` | string | optional | `"patch_only"` | 자유 문자열, 현재 동작 분기 없음 |
| `branch` | object | optional | (없음) | `branch.expected?: string` |
| `scope` | object | **필수** | — (§3) | 객체 자체는 생략 불가 |
| `forbidden_actions` | string[] | optional | `[]` | **enforce 안 함 — advisory (§7)** |
| `required_checks` | object | optional | `{ commands: [] }` | §6 |
| `git` | object | optional | `{}` → 각 불리언 기본값 적용 (§5) | |
| `report` | object | optional | (없음) | `report.required_items: string[]` (기본 `[]`) |

> **알 수 없는 필드는 조용히 버려진다(§8).** 위 표에 없는 키(예: `version`)는 추가하지 마라.

---

## 3. `scope` — **필수 키** (가장 흔한 실수)

```ts
scope: z.object({
  allowed_paths: z.array(z.string()).default([]),
  denied_paths:  z.array(z.string()).default([]),
})   // ← .optional() 도 .default() 도 없음 → scope 객체 자체는 필수
```

- **`scope` 키는 필수다.** 생략하면 계약 로드가 실패하고 CLI 는 **exit 2** 로 끝난다.
- 다만 **`scope.allowed_paths` / `scope.denied_paths` 는 생략 시 `[]` 로 기본 처리**된다.
- 따라서 **최소 유효 계약에는 `scope: {}` 가 필요**하다. (`scope` 줄을 통째로 빼면 안 된다.)

```yaml
# ❌ 잘못됨 — scope 누락 → load error → exit 2
id: x
required_checks:
  commands:
    - { name: t, command: "true" }
```

```yaml
# ✅ 올바름 — scope: {} 로 최소 충족 (allowed/denied 는 [] 기본)
id: x
scope: {}
required_checks:
  commands:
    - { name: t, command: "true" }
```

### scope 의미 (verify 동작)

- **`allowed_paths` 가 비어 있으면(`[]`) 범위-밖(out-of-scope) 양성 검사는 비활성**이다.
  - 즉 `allowed_paths: []` 는 "아무 파일이나 허용"이 아니라 **"allowed 기반 positive 검사를 끈다"** 는 뜻이다.
  - 이 경우 보호는 **`denied_paths`(금지 경로) + git 검사 + diff 증빙**으로 한다.
- `allowed_paths` 가 1개 이상이면, 변경된 파일 중 어떤 allowed 글롭에도 안 맞는 것이 `outOfScope` 위반이 된다.
- 경로 매칭은 `minimatch(file, glob, { dot: true })` (점파일 포함).

---

## 4. `branch`

```yaml
branch:
  expected: main      # optional. 현재 브랜치와 다르면 verify/pre 가 위반/경고로 본다.
```

- `branch` 와 `branch.expected` 모두 optional.
- `expected` 가 있고 현재 브랜치와 다르면: `verify` 는 `branch.ok=false`(위반), `pre` 는 시작 전 경고(§11).

---

## 5. `git` — 실제 기본값 (문서 예시 아님)

```ts
git: z.object({
  require_no_staged_untracked:      z.boolean().default(false),
  require_only_allowed_files_staged: z.boolean().default(false),
  require_no_denied_path_diff:       z.boolean().default(true),
  require_no_push:                   z.boolean().default(false),
}).default({})
```

| 키 | **실제 기본값** | true 일 때 검사 |
|---|---|---|
| `require_no_staged_untracked` | **`false`** | untracked 파일이 있으면 위반 |
| `require_only_allowed_files_staged` | **`false`** | allowed 밖 파일이 stage 되면 위반(`stagedOutOfScope`) |
| `require_no_denied_path_diff` | **`true`** | denied 경로가 변경되면 위반(`deniedHits`) — **기본 켜짐** |
| `require_no_push` | **`false`** | (push 관련 — verify 상태검사 범위) |

> `git` 블록을 생략하면 위 기본값(`false / false / true / false`)이 적용된다. **`require_no_denied_path_diff` 만 기본 `true`** 라는 점을 기억하라.

---

## 6. `required_checks` — `commands` 와 `nul`

```ts
required_checks: z.object({
  nul:      z.object({ paths: z.array(z.string()).default([]) }).optional(),
  commands: z.array(CommandCheck).default([]),
}).default({ commands: [] })

CommandCheck = z.object({
  name:          z.string(),              // 필수
  command:       z.string(),              // 필수
  required_exit: z.number().default(0),   // 기본 0
})
```

- `commands` 는 **`guard check`** 가 실행한다(§11). `guard verify` 는 commands 를 **실행하지 않는다**.
- 각 command 는 `/bin/sh` 로 실행되며, 실제 종료코드가 `required_exit`(기본 0)와 같아야 통과.
- `commands` 가 비어 있으면 `check` 는 **공허하게 PASS**(실행할 게 없음 = 통과).
- `nul.paths` 는 `verify` 가 NUL 바이트(파일 깨짐) 검사 대상으로 본다(`nulBad`).

---

## 7. `forbidden_actions` — **현재 verify 에서 enforce 되지 않는다**

```yaml
forbidden_actions:
  - push
  - deploy
```

- `forbidden_actions` 는 스키마에 존재하지만, **`runVerify` 는 이 필드를 참조하지 않는다.**
- 즉 **기계적으로 차단하는 필드가 아니다.** 현재는 **advisory(권고) / `guard prompt` 출력용 정보**에 가깝다.
- 이 필드에 `push`, `deploy` 등을 적어도 verify/check 가 그 행동을 막아주지 않는다. **막아준다고 설명하면 안 된다.**
- (실제 차단은 `git.*` 상태검사 + `denied_paths` + 사람/외부 게이트로 한다.)

---

## 8. 알 수 없는 필드 — 조용히 버려진다 (`version` 등 추가 금지)

- `ContractSchema` 는 기본(non-strict) zod 객체다. **스키마에 없는 키는 검증 없이 그냥 제거(strip)된다.**
- 따라서 `version: 0`, `schema_version` 같은 **새 필드를 적어도 오류는 안 나지만, 파서가 인식하지 않고 그냥 무시**한다(아무 효과 없음).
- **이런 미지 필드는 추가하지 마라.** 효과가 없을 뿐 아니라, "있는 것처럼" 의존하면 사고가 난다.
- 스키마 버전 필드는 v0.1 에 **존재하지 않는다.** v0.2 동안 스키마는 변경하지 않으므로(§11) 버전 필드도 도입하지 않는다.

---

## 9. Exit code 의미 (동결)

| code | 의미 |
|---|---|
| **0** | PASS — `verify` 위반 없음 / `check` 전 명령 통과 / `pre` 문제 없음 / `prompt`·`report` 정상 |
| **1** | 위반 — `verify` 상태 위반 / `check` 명령 실패 / `pre` 시작전 문제 |
| **2** | 로딩·환경 오류 — `--contract` 누락 / 계약 파일 없음 / 스키마 형식 오류 / git 저장소 아님(`verify`·`report`·`pre`) / 모르는 명령 |

---

## 10. `loadContract` 동작

1. 파일 읽기 실패 → `Error("계약서 파일을 못 찾음: <path>")` → CLI **exit 2**.
2. `yaml.parse()` 후 `ContractSchema.safeParse()`.
3. 검증 실패 → `Error("계약서 형식 오류 (<path>):\n  - <필드경로>: <메시지>")` → CLI **exit 2**.
4. 성공 → 기본값이 채워진 정규화 객체 반환.

---

## 11. 명령별 동작 + 출력 동결

Slice A 의 원칙은 **"출력 0 변경"** 이다. 아래 5개 명령의 **stdout / stderr / `--json` / exit code 는 Slice A 동안 동결 대상**이며, 회귀는 `test/golden/` baseline 으로 잡는다(A0.5 에서 11개 케이스 캡처 완료).

| 명령 | git repo 필요? | 한 일 | 종료코드 |
|---|---|---|---|
| `init --preset <generic\|nextjs-supabase\|promptia>` | 불필요 | `.agent-guard/contract.yaml`(preset) + `.agent-guard/README.md` 생성(§11.4). 기존 파일 있으면 덮어쓰지 않고 실패. preset 없음/모름은 사용오류. | 0/1/2 |
| `verify [--json]` | **필요**(`requireRepo`) | 상태검사만(브랜치/범위/금지/stage/untracked/NUL/ahead-behind). **commands 실행 안 함.** 사람모드=박스 리포트(stdout)+note(stderr). `--json`=stable JSON 한 줄만(stdout), note 억제. | 0/1 |
| `check` | 불필요 | `required_checks.commands` 만 `/bin/sh` 로 실행. 전부 통과해야 0. | 0/1 |
| `report [--out]` | **필요** | verify + 마크다운 보고서 저장(`--out`, 기본 `agent-guard-report-<id>.md`). | 0/1 |
| `receipt [--format json\|md] [--out]` | **필요** | verify + check 결과를 `.agent-guard/receipts/` 에 저장(AI Work Receipt, verify --json 14키와 별개 스키마 — §11.6). 기본 위치 밖 저장 시 안내(verify 가 제외 안 함). | 0/1 |
| `receipts [--latest\|--cat\|--dir]` | 불필요 | `.agent-guard/receipts/` 조회(read-only): 최신순 목록 / `--latest` 요약 / `--cat` 최신 내용 / `--dir` 경로. json 은 ok/contractId/timestamp/contentHash/magnitude/critical 요약, md 는 파일명만. 없으면 생성 안내. | 0 |
| `mode` | 불필요 | task/daily 작업 흐름 설명(read-only, 저장 파일 없음): 계약/session/baseline 상태 + 추천 모드 + 다음 명령. git 아니어도 안내. | 0 |
| `claims --file <claim.json>` | **필요** | AI 완료보고(JSON)를 git 실측과 대조(§11.7). 파일 없음/파싱실패=2, mismatch=1, 일치=0. | 0/1/2 |
| `explain` | **필요** | 왜 PASS/FAIL 인지 설명 + 규모/critical 경로 + recovery hint. **exit 는 verify 와 동일**(PASS 0 / FAIL 1). | 0/1 |
| `doctor` | 불필요 | 환경/설정 건강 점검(git / 계약 발견·유효 / baseline). 오류 시 1. | 0/1 |
| `lint` | 불필요 | 계약 품질 조언(allowed/denied/forbidden_actions/commands) — advisory. | 0 |
| `pre` | **필요** | 시작 전 점검(브랜치 불일치 / 이미 stage 된 파일). | 0/1 |
| `start` | **필요** | 작업 시작 baseline 을 `.agent-guard/session.json` 에 기록(§11.5). denied 가 이미 dirty 거나 session 이 이미 있으면 실패. | 0/1 |
| `status` | **필요** | 계약 범위 / baseline(session) 상태 / 브랜치 / 현재 변경 요약(read-only). | 0 |
| `reset` | 불필요 | baseline `.agent-guard/session.json` 제거(`contract.yaml`/`README.md` 는 유지). | 0 |
| `prompt` | 불필요 | 에이전트에 붙일 지시문 출력(`forbidden_actions` 표시 + scope-밖 중단/추가개선 금지/commit·push·deploy 금지 + completion claim JSON 형식 — §7). | 0 |
| `help` / `--help` | 불필요 | 사용법 출력. | 0 |
| `run` | 상황별 | (인자 없음)과 동일한 단일명령 라우팅 별칭. | 0/1/2 |
| (인자 없음) | 상황별 | 단일명령 라우팅: 계약 없음→init(promptia/generic 선택) / git 아님→check·lint / session 없음→start / session 있음→verify 실행 후 안내(PASS→check·receipt·claims / FAIL→explain·status·reset). | 0/1/2 |

> **check 환경 실패 구분**: command 가 **exit 127**(셸의 command-not-found 관례)로 끝나면 코드 실패가 아니라 "command not found / 환경 문제"로 표시한다. **exit code 규칙(0/1)은 불변** — 표시만 구분.
> **verify FAIL recovery hint**: `verify`(사람 모드)/`explain` 은 FAIL 시 위반 카테고리별 "다음 조치" 힌트를 덧붙인다(표시 전용 — 판정/`--json`/exit 불변, **자동 revert 없음**).

### 11.4 init — 계약 스캐폴딩 (`init`)

`init --preset <generic|nextjs-supabase|promptia>` 는 시작용 설정을 만든다(계약·git repo 불필요):

- **preset `promptia`**: Promptia(Next.js + Supabase + Vercel) 전용. `denied_paths` = `.env*`/`package-lock.json`/`pnpm-lock.yaml`/`supabase/migrations/**`/`vercel.json`/`.vercel/**`/`exports/**`/`docs/arch/json/**`. `allowed_paths` 는 일상 소스 트리를 넓게 허용(범위검사는 켜되 거슬리지 않게), `required_checks.commands` 는 비워두고 주석으로 예시만 둔다. `lint`/`doctor` 는 `id: promptia` 를 감지해 핵심 denied_paths 누락을 사실로 경고한다(점수화 없음).

- 생성물: `.agent-guard/contract.yaml`(선택 preset 의 계약) + `.agent-guard/README.md`(에이전트 안내).
- **안전조건 — 덮어쓰기 금지**: 둘 중 하나라도 이미 있으면 **실패(exit 1), 아무것도 안 씀.** 모르는/없는 `--preset` = 사용오류(exit 2).
- 생성된 `contract.yaml` 은 이후 모든 명령이 기본 위치에서 자동탐색한다(`--contract` 생략 가능).
- **관계**: `init`(계약 생성) → (선택) `start`(baseline 기록, §11.5) → `verify`/`check`(계약 기준 평가). init/start 의 생성물(`contract.yaml`/`README.md`)은 `.agent-guard/session.json` 과 달리 verify 에서 제외되지 않는다(사용자가 커밋할 수 있는 실제 파일이므로).
- **주의 — start 전 verify**: 위와 같이 `init` 산출물(`.agent-guard/contract.yaml`/`README.md`)은 untracked 이고 verify 에서 제외되지 않으므로(**`session.json`/`receipts/` 만 제외** — §11.5), restrictive `allowed_paths` 에서 **start 전에 verify** 하면 outOfScope 로 잡힐 수 있다. **이는 정상 동작이다.** 권장 순서(`init`→edit→**`start`**→`verify`/`check`)를 따르면 baseline 에 묻혀 사라진다. 또는 그 두 경로를 `allowed_paths` 에 포함하거나, 계약 파일을 커밋/관리 대상으로 다뤄라.

### verify 상태검사 의미 (요약)

- `touched` = unstaged ∪ staged ∪ untracked (중복 제거).
- `outOfScope` = `allowed_paths` 가 1개 이상일 때만 계산(비면 `[]` — §3).
- `deniedHits` = `git.require_no_denied_path_diff`(기본 true)일 때 denied 경로 변경.
- `stagedOutOfScope` = `git.require_only_allowed_files_staged`(기본 false)일 때.
- untracked 위반 = `git.require_no_staged_untracked`(기본 false)일 때.
- `aheadBehind` = `origin/main` 기준. upstream 없으면 `null`.
- (baseline) 유효 `.agent-guard/session.json` 이 있으면 위 검사는 baseline 이후 신규 변경만 본다 — **`deniedHits` 는 예외(항상 full touched)**. 상세는 §11.5.

---

## 11.5 baseline / session (`start`)

`agent-guard start` 는 작업 시작 시점의 working tree 를 `.agent-guard/session.json` 에 baseline 으로 기록한다. 목적: 작업 *이전*부터 있던 ambient untracked 노이즈를 제거하고, verify 가 baseline *이후* 변경만 평가하게 한다.

- **session 스키마**(계약 스키마와 무관, 독립): `version(1) · baselineHead · createdAt · contractId · gitBranch · unstagedAtStart · stagedAtStart · untrackedAtStart`.
- **verify 의 baseline 적용**:
  - 유효 session 없음 → 기존(full-tree) 동작 그대로(완전 후방호환).
  - 유효 session 있음 → `touched`/`outOfScope`/`stagedOutOfScope`/untracked 검사는 **baseline 이후 신규 변경만**(현재 − `*AtStart` + `baselineHead..HEAD` 커밋분) 기준.
  - **`deniedHits` 는 항상 full touched 기준 — baseline 으로 denied 를 숨길 수 없다.**
  - `.agent-guard/session.json` 과 `.agent-guard/receipts/`(tool 산출) 만 verify 에서 제외(나머지 `.agent-guard/**` 는 일반 파일로 취급 — `contract.yaml` 등은 그대로 잡힌다).
  - session 유효성 = `gitBranch` 일치 + `baselineHead` 가 `HEAD` 의 조상. 무효(branch 변경/rebase 등)면 **baseline 무시 + full-tree degrade**(숨기지 않고 시끄러운 쪽으로).
- **`verify --json` 14키는 baseline 적용 후에도 동결**(§12) — 값만 baseline-relative 로 바뀌고 키는 그대로.

### start 안전조건 — denied 가 이미 dirty 면 실패

`start` 시 이미 dirty 한(unstaged/staged/untracked) 파일이 `denied_paths` 에 매칭되면 **start 는 실패하고 session 을 쓰지 않는다.** dirty 한 denied 를 baseline 으로 묻으면 위험 변경이 "원래 있던 것"처럼 숨겨지기 때문이다. (기존 session 이 있어도 덮어쓰지 않고 실패 — 실수로 baseline 이 밀려 작업이 숨는 것 방지.)

**이는 우회 대상이 아니라 안전 조건이다.** 해결:

- 문제 untracked 를 정리 / `git add`+commit / gitignore, 또는
- `denied_paths` 글롭을 ambient 파일과 겹치지 않게 축소.

**안전 우회 플래그는 만들지 않는다 — 거부가 정답이다.**

> baseline 은 **경로 집합** 비교지 내용 해시가 아니다. start 시점에 이미 untracked 였던 파일을 이후 *내용 수정*해도 (denied 가 아니면) 탐지 안 될 수 있다. denied 는 항상 full tree 기준이라 예외.

---

## 11.6 receipt 확장 필드 (magnitude / critical paths / contentHash)

`receipt` 가 저장하는 **AI Work Receipt** 는 `verify --json`(14키, §12)와 **별개 스키마**다. v0.4 에서 3개 필드가 추가됐다(다른 명령 출력·14키 JSON 에는 영향 없음):

- **`magnitude`** `{ filesChanged, added, deleted, newFiles }` — `git diff HEAD --numstat`(추적 파일 라인 수) + untracked 신규 파일 수. **full working tree 기준(baseline-relative 아님)**, 숫자만(점수화/판단 없음). 비ASCII 경로와 무관(경로 문자열 미사용).
- **`criticalPaths`** `[{ glob, touched[] }]` — 고정 **코드 상수**(계약 스키마 필드 아님)인 고위험 글롭(`​.env*`, `package-lock.json`, `pnpm-lock.yaml`, `supabase/migrations/**`, `vercel.json`, `.github/workflows/**`)에 full-tree 변경이 닿았는지 표시. `denied_paths` 와 겹쳐도 됨. **표시만**(차단 아님).
- **`contentHash`** `"sha256:<hex>"` — Node 내장 `crypto`(sha256, **새 의존성 없음**)로 만든 무결성 해시. 입력은 결정론적 git 실측: `headHash` + `touched`/`staged`/`untracked`/`outOfScope`/`deniedHits`(정렬) + `magnitude` + critical 의 touched + `checks`. **`timestamp` 은 입력에서 제외**(시간마다 바뀌므로 — 같은 git 상태면 같은 hash). ed25519 **서명은 백로그**(이 버전 미구현).

## 11.7 completion claim verifier (`claims`)

`claims --file <claim.json>` 는 AI 완료보고를 git 실측과 대조한다. **AI claim 은 절대 진실로 간주하지 않는다** — 판정은 `runVerify`/`runCheck` 실측만 사용한다.

- claim JSON 필드(전부 optional, 제공된 것만 비교): `changedFiles[]`(↔ `touched`) · `newFiles[]`(↔ `untracked`) · `deniedHits[]`(↔ `deniedHits`) · `tests`(boolean ↔ `check` 통과) · `summary`(참고용, 검증 안 함).
- 집합 비교로 "AI said / Git says" 를 출력. 특히 **git 에 있는데 claim 에 없는 변경**(=숨긴 변경)을 잡는다.
- exit: 파일 없음/JSON 파싱 실패 = **2**, mismatch = **1**, 일치(또는 비교할 필드 없음) = **0**.
- `prompt` 출력의 완료보고 JSON 형식과 짝을 이룬다(§7 / `buildPrompt`).

## 12. `verify --json` 출력 — stable 14 키 (동결)

기계용 출력은 **stdout 에 JSON 한 줄만** 나오고, 사람용 note 는 나오지 않는다. 키 집합은 정확히 다음 14개로 동결한다.

```
ok, contractId, title, branch{current,expected,ok},
touched, staged, untracked, outOfScope, deniedHits,
stagedOutOfScope, nulBad, violations, headHash, aheadBehind
```

- 누락 가능한 값은 키를 유지하고 값만 `null` 로 정규화한다(`title`, `branch.expected`, `aheadBehind`).
- **의도적으로 제외**된 내부 필드: `commands`, `nulPaths`, `changed`. (출력에 넣지 않는다.)

---

## 13. 계약 예시

### 최소 유효 계약

```yaml
id: minimal
scope: {}
```

### 일반적인 patch-only 계약

```yaml
id: gate-example
title: 예시 게이트
mode: patch_only
branch:
  expected: main
scope:
  allowed_paths:
    - "src/**"
  denied_paths:
    - "package.json"
    - "supabase/migrations/**"
forbidden_actions:        # advisory — verify 가 막지 않음 (§7)
  - push
  - deploy
required_checks:
  nul:
    paths:
      - "src/**"
  commands:
    - name: tsc
      command: "tsc --noEmit"
      required_exit: 0
git:
  require_no_staged_untracked: false
  require_only_allowed_files_staged: false
  require_no_denied_path_diff: true     # 기본 켜짐
  require_no_push: false
report:
  required_items:
    - 변경 요약
```

---

## 14. 동결 선언

1. **이 스키마는 v0.2 동안 변경하지 않는다.** 필드 추가/삭제/의미 변경 금지.
2. **`verify` / `check` / `prompt` / `report` / `pre` 의 stdout / stderr / `--json` / exit code 는 Slice A 동안 동결**이다. 회귀는 `test/golden/` 로 검출한다.
3. 스키마에 없는 새 필드(`version` 등)는 도입하지 않는다(§8).
4. 이 문서와 `src/schema.ts` 가 충돌하면 **`src/schema.ts` 가 SSOT** 다.
5. **`start`(P1)는 `.agent-guard/session.json`(별도 session 스키마, §11.5)을 쓴다 — 계약 스키마(§1–§13)와 무관.** baseline 적용 후에도 `verify --json` 14키는 동결 유지.
6. **v0.4 추가(`claims`/`explain` 명령, receipt 확장 필드 §11.6, exit127 구분, recovery hint, prompt 강화)는 계약 스키마(§2–§8)와 `verify --json` 14키(§12)를 바꾸지 않는다.** 새 증거(magnitude/critical/contentHash)는 **receipt 스키마 한정**이고, critical paths 는 계약 필드가 아니라 코드 상수다. 단, `verify`(사람 모드)/`prompt` 의 **사람용 stdout 은 의도적으로 확장**됐다(recovery hint·완료보고 JSON 형식) — `test/golden/` baseline 을 그에 맞게 갱신했다(기계용 `--json` 은 불변).
7. **v0.5 추가(`promptia` preset, `run` 별칭, promptia 감지 `lint`/`doctor` 경고, router PASS/FAIL 안내 강화)도 계약 스키마와 `verify --json` 14키를 바꾸지 않는다.** `promptia` 는 새 template 파일(`templates/promptia.yaml`)일 뿐 스키마 확장이 아니다(기존 필드만 사용). promptia 감지는 `id: promptia` 기반 advisory 경고로 점수화하지 않는다. `run` 은 (인자 없음) 라우팅의 별칭이며 새 판정 로직이 아니다. 라우팅/lint/doctor 의 **사람용 stdout 확장**은 `test/golden/` 에 반영했다(v04-06/v04-08 갱신 + v05-01~06 추가).
8. **v0.6 추가(`mode`, `receipts` 명령)도 계약 스키마와 `verify --json` 14키를 바꾸지 않는다.** 둘 다 read-only 이고 새 저장 스키마를 만들지 않는다 — `mode` 는 task/daily 흐름 설명(저장 파일 없음), `receipts` 는 기존 receipt 파일 조회일 뿐이다(점수화·등급화 없음, AI 진실 간주 없음, 자동 revert 없음). `receipt` 출력에 기본위치-밖 저장 안내 1줄을 추가했다(verify 판정/제외 규칙 불변 — `.agent-guard/receipts/` 만 제외). golden: v1-01~03 갱신(receipt 안내) + v06-01~07 추가. 3문서 기능 매핑은 `docs/coverage.md` 참고.
