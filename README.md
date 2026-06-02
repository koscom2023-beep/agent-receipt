# agent-guard

AI(Cursor/Claude Code)에게 일을 시키기 전에 **작업 계약서**를 만들고,
작업이 끝난 뒤 **계약을 지켰는지 기계적으로 검사**하는 로컬 CLI.

핵심 한 줄: *AI를 조종하는 도구가 아니라, AI가 한 일을 검수하는 도구.*

---

## 설치 (Promptia 레포에 넣는 경우)

이 폴더를 레포 안 `tools/agent-guard/` 에 둔다. 그리고 루트에서:

```bash
pnpm add -D tsx typescript @types/node
pnpm add minimatch yaml zod
```

루트 `package.json`의 `scripts`에 한 줄 추가:

```json
{
  "scripts": {
    "guard": "tsx tools/agent-guard/src/cli.ts"
  }
}
```

이제 `pnpm guard verify --contract <경로>` 로 쓴다.

---

## 명령 5개

| 명령 | 하는 일 |
|------|---------|
| `guard pre`    | 작업 시작 전 점검 (브랜치 맞는지, 이미 stage된 거 없는지) |
| `guard prompt` | 계약서를 읽고 Cursor/Claude에 붙여넣을 지시문 생성 |
| `guard verify` | 작업 후 **상태** 검사: diff/범위/금지파일/NUL. 위반 있으면 exit 1. **명령(테스트/빌드)은 실행 안 함** |
| `guard verify --json` | 사람용 보고서 대신 **기계용 stable JSON**을 stdout에 단독 출력 (CI용) |
| `guard check`  | 계약의 `required_checks.commands`(tsc/test 등)**만 실행**. git 불필요 |
| `guard report` | verify + 결과를 마크다운 파일로 저장 (`--out 경로`) |

> **verify ≠ check** — `verify`는 **상태만** 본다(빠름). 테스트·빌드는 `check`가 돌린다.
> 작업 후 게이트는 **둘 다** 통과시켜라: `guard verify && guard check`.
> `verify` 단독 통과는 "테스트도 통과"가 아니다(아래 위협모델 참고).

```bash
pnpm guard pre     --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard prompt  --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard verify  --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard verify  --contract tools/agent-guard/contracts/gate-3a-p0.yaml --json   # 기계용 JSON
pnpm guard check   --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard report  --contract tools/agent-guard/contracts/gate-3a-p0.yaml --out report.md
```

### `verify --json` 출력 (기계용 stable 계약)

`--json`은 아래 **spec 필드만** stdout에 한 줄 JSON으로 낸다(키 집합·순서 고정). exit code: PASS=0 / 위반=1 / 로딩·환경 오류=2(이때 stdout엔 JSON 없음, stderr만).

```json
{"ok":true,"contractId":"...","title":null,"branch":{"current":"main","expected":null,"ok":true},"touched":[],"staged":[],"untracked":[],"outOfScope":[],"deniedHits":[],"stagedOutOfScope":[],"nulBad":[],"violations":[],"headHash":"...","aheadBehind":null}
```

- 옵셔널 필드(`title`, `branch.expected`)는 없으면 `null`로 **키가 유지**된다(키 집합 불변).
- `aheadBehind`는 upstream(`origin/main`) 없으면 `null`.
- 내부 필드(`commands`, `nulPaths` 등)는 **출력하지 않는다**. 안정 보장 대상은 위 spec 필드뿐 — CI는 키 형태가 아니라 **`ok` 값과 exit code**에 의존하라.

---

## 작업 순서 (이걸 고정하면 끝)

1. **계약서 작성** — `contracts/xxx.yaml` 에 허용/금지 파일, 필수 테스트를 적는다
2. `pnpm guard pre ...` — 시작해도 안전한지 확인
3. `pnpm guard prompt ...` — 나온 지시문을 Cursor/Claude에 붙여넣고 작업 시킴
4. AI가 작업
5. `pnpm guard verify ...`(상태) + `pnpm guard check ...`(테스트/빌드) — **둘 다 PASS 전엔 커밋 금지** (`verify && check`)
6. PASS면 허용 파일만 직접 `git add` 후 커밋
7. (선택) `pnpm guard report ...` 로 완료 보고서 남김

---

## 계약서(YAML) 항목 설명

```yaml
id: ...                 # 계약 이름
branch:
  expected: <브랜치>     # 이 브랜치가 아니면 verify 실패
scope:
  allowed_paths: [...]  # 이 파일들만 수정 허용 (이 밖이면 실패)
  denied_paths: [...]   # 절대 금지 영역. glob 가능: src/app/**
required_checks:
  nul:
    paths: [...]        # 이 파일들에 깨진 NUL 바이트 있으면 실패
  commands:             # exit 코드가 required_exit와 다르면 실패
    - name: tsc
      command: pnpm tsc --noEmit
      required_exit: 0
git:
  require_no_denied_path_diff: true        # 금지 파일에 변경 있으면 실패
  require_only_allowed_files_staged: true  # 허용 밖 파일이 stage되면 실패
  require_no_staged_untracked: true        # 정리 안 된 새 파일 있으면 실패
```

검사 대상은 `git diff` + `git diff --cached` + 새 파일(untracked)을 **전부 합친 것**이다.
즉 stage를 했든 안 했든 AI가 건드린 파일은 다 잡힌다.

---

## 위협 모델 — 막는 것 / 못 막는 것 (과신 금지)

이건 **보안 솔루션이 아니라 "AI 변경통제 보조 + 감사" 도구**다.

**막는 것** (정적 검사, 위반 시 exit 1):
- 허용 범위 밖 파일 변경, 금지(`denied_paths`) 경로 접촉
- 허용 밖 파일이 stage됨, 정리 안 된 새 파일(untracked)
- 지정 파일의 NUL 바이트(파일 깨짐)

**못 막는 것** (알고 써라):
- **`verify`는 테스트/빌드를 실행하지 않는다** — 런타임/통합 결함은 못 잡는다. 그건 `check` 책임이며, `check`를 게이트에서 빠뜨리면 verify가 PASS여도 검증된 게 아니다.
- **push는 완벽히 못 막는다.** `origin/main` 대비 앞/뒤 커밋 수만 참고로 보여준다. 확실히 막으려면 git pre-push hook을 따로 걸어라.
- glob은 `minimatch` 기본 동작을 따른다. (`**`는 폴더 가로질러 매칭)
- 파일 경로에 특수문자(따옴표/공백/비ASCII)가 있으면 git이 따옴표로 감싸는데, 그건 아직 처리 안 함.
- 악의적 사용자·셸 우회·OS 권한 밖은 범위 밖.

설계 근거·14인 회의록은 [`docs/v0.1-design-log.md`](docs/v0.1-design-log.md) 참고.

---

## 다음에 붙일 것 (지금은 안 함)

- `guard stage` : 허용 파일만 자동 `git add`
- `guard new`   : 질문 받아서 계약서 YAML 자동 생성
- pre-push hook 연동으로 push 진짜 차단
- 이게 익으면 → 외부 제품(Agent Change Control)으로 확장
