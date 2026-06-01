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

## 명령 4개

| 명령 | 하는 일 |
|------|---------|
| `guard pre`    | 작업 시작 전 점검 (브랜치 맞는지, 이미 stage된 거 없는지) |
| `guard prompt` | 계약서를 읽고 Cursor/Claude에 붙여넣을 지시문 생성 |
| `guard verify` | 작업 후 diff/범위/금지파일/NUL/테스트 검사. 위반 있으면 exit 1 |
| `guard report` | verify + 결과를 마크다운 파일로 저장 (`--out 경로`) |

```bash
pnpm guard pre     --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard prompt  --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard verify  --contract tools/agent-guard/contracts/gate-3a-p0.yaml
pnpm guard report  --contract tools/agent-guard/contracts/gate-3a-p0.yaml --out report.md
```

---

## 작업 순서 (이걸 고정하면 끝)

1. **계약서 작성** — `contracts/xxx.yaml` 에 허용/금지 파일, 필수 테스트를 적는다
2. `pnpm guard pre ...` — 시작해도 안전한지 확인
3. `pnpm guard prompt ...` — 나온 지시문을 Cursor/Claude에 붙여넣고 작업 시킴
4. AI가 작업
5. `pnpm guard verify ...` — **PASS 나오기 전엔 커밋 금지**
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

## v0 한계 (알고 쓰기)

- **push는 완벽히 못 막는다.** `origin/main` 대비 앞/뒤 커밋 수만 참고로 보여준다.
  push 차단은 git pre-push hook으로 따로 거는 게 확실하다.
- glob은 `minimatch` 기본 동작을 따른다. (`**`는 폴더 가로질러 매칭)
- 파일 경로에 특수문자가 있으면 git이 따옴표로 감싸는데, 그건 아직 처리 안 함.

---

## 다음에 붙일 것 (지금은 안 함)

- `guard stage` : 허용 파일만 자동 `git add`
- `guard new`   : 질문 받아서 계약서 YAML 자동 생성
- pre-push hook 연동으로 push 진짜 차단
- 이게 익으면 → 외부 제품(Agent Change Control)으로 확장
