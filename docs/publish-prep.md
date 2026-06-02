# Publish 준비 로그 (npm)

이 문서는 npm publish 준비 과정의 결정·근거·남은 항목을 누적한다. (실제 `npm publish`·login 은 아직 안 함.)

## 결정 (확정)

- **패키지명: `@promptia/agent-receipt`** (scoped).
  - 근거: unscoped `agent-guard` 는 npm 점유됨(`npm view agent-guard` = `1.2.2`, 무관한 패키지 → 탈취 금지). scoped 로 충돌 회피 + `@promptia` 브랜드 자산.
  - 정체성: "AI Work Receipt"(증명/영수증). guard(차단) 오해 감소.
- **CLI 명령(bin): `agent-receipt`** (단일). 기존 `agent-guard`·`ag` bin 제거.
  - `ag` 제거 근거: silver-searcher 등 기존 `ag` 명령과 전역 설치 충돌 위험.
- **scoped public 공개**: `publishConfig.access: "public"` (scoped 는 기본 restricted → 무료 공개시 명시 필요).

## 이번 단계(publish 2단계 경량)에서 한 변경

`package.json`:
- `name` → `@promptia/agent-receipt`
- `private: true` **제거** (private 면 publish 거부)
- `bin` → `{ "agent-receipt": "dist/cli.js" }` (agent-guard·ag 제거)
- `prepack: "npm run build"` 추가 (pack·publish 시 dist 자동 빌드 → tarball 항상 최신)
- `description`, `license`, `engines.node >=18`, `publishConfig.access: public` 추가
- 유지: `version 0.2.0`, `files`(dist/templates/README/CONTRACT), deps, `scripts.build`/`guard`

`README.md`: 제목·설치(`npm install -D @promptia/agent-receipt`)·명령(`agent-receipt …`)·바이너리 줄 반영. `.agent-guard/`(제어 디렉터리)·`agent-guard.yaml`(자동탐색 파일명)·`npm run guard`(dev)는 코드명이라 유지.

**런타임 출력/판정/golden 변화 0** — 패키징·문서 변경만. golden 34케이스 byte-identical 재검증.

## 연기 (실제 publish 전 별도 작업 — 각각 golden/코드 영향)

1. ~~CLI 내부 출력 문자열 정렬~~ → **완료**: `printHelp`(init/start 추가 + agent-receipt), `--contract` 누락 메시지, verify note(`agent-receipt check`), `init.ts` unknown-preset, `output.ts` stale 경고(`agent-receipt start`), `templates/agent-readme.md`(제목·SSOT·verify/check) 를 `agent-receipt` 로 정렬. golden 의도적 갱신(stderr note·new-07·p1a-04·p1b-08·new-04/05 created-README). **유지(미변경)**: 기본 리포트 파일명 `agent-guard-report-<id>.md`(내부 파일명+.gitignore 연동), `.agent-guard/` 디렉터리, `agent-guard.yaml`/`.json` 자동탐색.
2. **제어 디렉터리/자동탐색 파일명**: `.agent-guard/` 와 `agent-guard.yaml`/`agent-guard.json`(discover.ts `DEFAULT_CONTRACT_PATHS`). 브랜드 일치를 위해 `.agent-receipt/`·`agent-receipt.yaml` 로 갈지 = **열린 결정**(breaking + 코드+golden). 현재 유지.
3. ~~LICENSE 결정~~ → **확정: MIT** (오너 결정, 무료 공개 CLI/채택 유도; Promptia 본진 코드와 별개). `license: "MIT"` + `LICENSE` 파일(저작권자 `Promptia`, 2026 — 필요시 법인명 조정) 적용 완료. npm 은 LICENSE 를 tarball 에 자동 포함.
4. **`repository`/`author`/`homepage`**: git remote(origin) 미설정(push 0)이라 URL 없음 → remote 생기면 추가.
5. **실제 `npm publish` + npm login/token**: 미실행. 외부 공개·사실상 영구 → 최종 별도 신중 승인.

## 배포 전 체크리스트

- [x] name scoped 확정 (`@promptia/agent-receipt`)
- [x] `private` 제거 / `publishConfig.access: public`
- [x] bin 단일화(`agent-receipt`), `ag` 제거
- [x] `prepack` 빌드훅
- [x] description/engines
- [x] README 설치·명령 반영
- [x] CLI 출력 문자열 정렬 — `agent-receipt` (golden 갱신 완료)
- [x] LICENSE 확정 — **MIT** (license:MIT + LICENSE 파일)
- [ ] repository/author (연기 4)
- [ ] (선택) 제어 디렉터리/discover 파일명 리브랜드 결정 (연기 2)
- [ ] `npm pack` 산출물 최종 점검 → `npm publish --access public` (연기 5, 최종 승인)
