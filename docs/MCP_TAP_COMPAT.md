# mcp-tap 호환표 & 배선 레시피

> 실측 기준(정직 표기): 아래는 **이 환경(Linux/WSL·Node 20·npx/uvx)에서 실제로 감싸 돌린 결과**다.
> 미실측 항목은 "미실측"으로 남긴다 — 통과로 위조하지 않는다(4차 회의 ⑪·⑬).
> 재현 러너: probe(핸드셰이크) + initialize/tools/list/실호출 1세트 후 `tap verify`.

## 실측 결과 (5종 · 전부 체인 무결·정상 종료)

| 서버 | 전송 | 도구 수 | 관측된 클래스 | 병합 창 | 알림 | 체인 | 비고 |
|---|---|---|---|---|---|---|---|
| `@modelcontextprotocol/server-filesystem` | stdio | 14 | fs-write 1 · fs-read 4 | 1 | 0 | 무결 | 동일 read 3회 → repeat 1창으로 무손실 병합 |
| `@modelcontextprotocol/server-memory` | stdio | 9 | unknown 1 · fs-read 1 | 0 | 0 | 무결 | create_entities=unknown(도메인 렉시콘 밖·정직) |
| `@modelcontextprotocol/server-everything` | stdio | 13 | unknown 1(echo) | 0 | 2 | 무결 | 진행률 notification 2건 관측 |
| `mcp-server-sqlite` (uvx·Python) | stdio | 6 | **db-write 2 · db-read 2** | 1 | 0 | 무결 | CREATE·INSERT=db-write / SELECT=db-read (선두 토큰 실증) |
| `mcp-server-git` (uvx·Python) | stdio | 12 | fs-read 1 | 0 | 0 | 무결 | git_status=fs-read |

공통 확인: **서버의 stderr 는 손대지 않고 통과**(기록 안 함)·**중계 무결**(응답 전부 정상 수신)·**정상 종료 도장** 기록·**값 미저장**(경로/쿼리 원문 로그 부재). Python(uvx) 서버도 Node 서버와 동일하게 동작 — 프록시가 언어 무관임을 실측.

## 미실측 (제약 정직 표기 · 통과 아님)

| 서버 | 사유 |
|---|---|
| `@modelcontextprotocol/server-github` | GitHub 토큰 필요(이 환경 미설정) — 배선 형태는 filesystem 과 동일 stdio 라 동작 예상, 단 **미실측** |
| `@playwright/mcp` | 브라우저 바이너리 설치 필요 — **미실측** |
| Windows 네이티브(비 WSL) | cmd/인용부호·코드페이지 경로 미검증 — v1 지원 선언은 **POSIX+WSL 한정**(Cursor 브리지 BOM/CRLF 상처 선례) |

## 오버헤드 (정직 표기)

probe(콜드 스타트·서버 다운로드 포함) 1.7~4.6초는 **서버 기동 시간**이지 tap 오버헤드가 아니다. tap 자체는 프레임당 파싱+해시 1회(수 µs 규모)로 stdio 지연에 묻히나, **엄밀한 프레임당 마이크로벤치는 미측정** — 다음 트레인에서 숫자로 박는다(현재 "무시할 수준" 주장은 근거 미제출이라 하지 않는다).

## 배선 레시피 (사용자용)

### 1) 설정 파일이 있는 클라이언트(권장·자동)
```
agent-receipt tap install            # 미리보기(무변경)
agent-receipt tap install --write    # ./.mcp.json · ./.cursor/mcp.json 감쌈(멱등)
agent-receipt tap probe              # 감싼 채 initialize 왕복 스모크
# ...평소처럼 에이전트 작업...
agent-receipt tap status             # 감싼 서버·정상 종료 여부
agent-receipt tap show --by class    # 클래스별 카운트
agent-receipt tap verify             # 체인 무결성(변조면 exit 1)
agent-receipt tap uninstall --write  # sidecar 원본으로 정확 복원
```

### 2) 자체 파이프라인(커스텀 루프·설정 파일 없음)
서버 실행 커맨드 앞에 프록시를 직접 끼운다. `--log-dir` 는 **절대경로**여야 한다(CWD 무관).
```
# 원래:  my-server --flag
# 감쌈:  agent-receipt mcp-tap --server-name my-server \
#                --log-dir /abs/repo/.agent-guard/tap -- my-server --flag
```
- fail-open: tap 기록이 실패해도 stdin/stdout 중계는 무결(에이전트 안 멈춤).
- 긴급 정지: `AGENT_RECEIPT_TAP_OFF=1`(순수 중계 + bypass 표식 1줄 — 몰래 우회 없음).
- HTTP/SSE 전송 서버는 v1 범위 밖 — install 이 `coverage.unwrapped(transport-http)` 로 자백한다(감쌀 수 없음을 침묵하지 않음).

## 재현 방법
러너(`mcp-matrix.mjs`)는 각 서버를 임시 `.mcp.json` 에 넣고 `tap install --write` → `tap probe` → 감싼 커맨드로 initialize/tools/list/실호출 → `tap verify` → 로그 판독 순으로 돈다. 산출 ROW JSON 이 위 표의 근거다.
