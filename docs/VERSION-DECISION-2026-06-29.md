# 버전 재기준 결정 (2026-06-29 · 4차 council "다" 안건)

> ADR. 미래에 "왜 1.0 만빵으로 안 갔나"를 한 장으로 답하고, 1.0 draft 재개를 막는 가드.

## 배경
- 현재: `package.json` **0.10.0**, git 태그 `v0.10.0` 1개. `docs/RELEASE-1.0.0-draft.md` = 다음 릴리스를 *기능 만빵 1.0*(install-hooks·ledger·dashboard·attest·sign·keys…)으로 계획.
- 4차 전략 council 결론과 충돌: **표면 3개(begin/done/share-proof)·git 너머 캡처가 비협상·기능 만빵 1.0 금지.**
- owner가 "0.1.0버전에서 적용"이라 언급 → semver상 0.10→0.1 **역행 불가**. "0.1.0"은 *제품 세대* 의미로 해석.

## 결정
1. **package.json 0.10.0 유지. 지금 bump 0**(빈 릴리스 금지).
2. 다음 *초점 릴리스* = **0.11.0**(역행 0). 표면 축소 + capture 알파를 담는다.
3. **"focused v0.1"은 내러티브 라벨**(README/마케팅), npm 숫자 아님. 숫자(0.11.x) ↔ 세대(초점 제품 1세대) 매핑을 문서로 명시.
4. **1.0 재정의:** "기능 수"가 아니라 **"git 너머 캡처 해자 + share-proof 검증됨" = 1.0**. draft의 기능들은 1.0 헤드라인이 아니라 **기본 표면에서 숨긴 채석장**(council #4)으로 강등.
5. `RELEASE-1.0.0-draft.md`는 **삭제하지 않고** 상단 deferred 배너만(history·투명성).
6. **publish = owner 전용(hard-stop).** council·loop 권한 0. 0.10.0 npm 게시 여부는 초점 릴리스 직전 owner 확인.

## 불변식 (이 결정의 조건 — 악마의 대변자 승인 조건)
- package.json 숫자 무변경(이번 적용은 docs-only).
- 1.0 draft 삭제 금지(배너만).
- 이 루프에서 publish 0.
- `verify --json` 14키 · `schemaVersion` 불변.

## 미해소 (owner 결정 대기)
- 0.10.0이 npm에 이미 publish됐는지 미확인 → unpublish 불가 여부가 초점 릴리스 번호에 영향.

## 다음
- (가) capture 알파(0.11.0의 핵심) 착수 — `docs/RELEASE-1.0.0-draft.md`를 SoT로 읽지 말 것(deferred).
