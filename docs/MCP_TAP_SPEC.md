# MCP_TAP_SPEC.md · `mcp-tap` 기술 스펙

> **상태: v0.3** (구현과 동행하는 설계 문서 · 1차 회의=설계, 2차 회의=미결 4건 확정, 3차 회의=코드 실측 대조 수정 14건 반영)
> 대상: agent-receipt 다음 배포 창 · 레코드 스키마: `tap/1`
> 이 문서가 코드와 어긋나면 코드(및 `src/schema.ts` 계열 SSOT)가 이긴다.

## 0. 한 줄 정의

`mcp-tap` 은 에이전트와 MCP 서버 사이에 끼어드는 "관측 전용" stdio 프록시다.
도구 호출(tools/call)을 값 없이(해시·형태만) 해시체인에 기록하고, 기록은 영수증의 새 관측 소스(Observation Source)가 된다. 게이트웨이가 아니고, 차단기가 아니며, 실패 시 열린다(fail-open).

기존 capture(벤더 훅)와의 관계는 상보: capture 는 벤더(Claude Code/Cursor)가 보여주는 것을 보고, tap 은 MCP 프로토콜 계층에서 벤더 무관하게 본다. 같은 행위가 둘 다에 잡히면 대사(reconcile) 단계에서 병합한다(§9).

## 1. 목표

- **G1 벤더 중립 관측.** MCP 를 쓰는 어떤 에이전트든 도구 호출 증거를 동일 스키마로 남긴다.
- **G2 git 밖 행위의 1차 커버.** DB 쓰기·배포·외부 API 등 "MCP 도구를 경유하는" 행위를 관측한다.
- **G3 변조·누락 탐지.** capture 와 동일한 봉인사슬(seq + prevHash + entryHash)로 사후 조작·삭제·재배열·갭을 탐지 가능하게.
- **G4 값 미저장 원칙.** 인자·결과의 원문은 절대 저장하지 않는다. 형태(키 목록)·크기·digest 만.
- **G5 byte-invariant.** tap 없이 만든 영수증은 기존과 바이트 동일. tap 데이터는 additive 블록으로만.

## 2. 비-목표 (정직 표기)

- **차단하지 않는다.** deny 는 기존 guard(policy)·벤더 PreToolUse 훅의 영역. tap 은 증거다.
- **게이트웨이가 아니다.** 인증·라우팅·RBAC·레이트리밋 없음. 기업 게이트웨이 로그는 v2 어댑터가 이 스키마로 ingest.
- **MCP 밖은 못 본다.** raw bash·직접 HTTP 는 사각지대(벤더 훅 capture 가 일부 커버). 커버리지 선언(§9)으로 표면화.
- **v1 은 stdio 전송만.** Streamable HTTP/SSE 는 v1.1.
- **내용 증명이 아니다.** 가능한 것은 "이 digest 와 일치하는 인자로 이 도구를 이 순서에 호출했다"까지.

## 3. 용어

| 용어 | 뜻 |
|---|---|
| tap | 본 프록시 프로세스 |
| child | tap 이 spawn 하는 원래 MCP 서버 프로세스 |
| frame | stdio 위 JSON-RPC 2.0 메시지 1건(개행 구분) |
| record | tap 이 남기는 관측 레코드 1줄(JSONL) |
| tapMeta | 부팅마다 1회 기록되는 머리 레코드 |
| opaque frame | 파싱 실패한 frame · 크기·digest 만 기록하고 통과 |
| sidecar | `.agent-guard/tap/wrapped.json` · 감싼 서버의 원본 커맨드/설정 기록(복원 정본) |

## 4. 배선(Wiring)

### 4.1 원리 (v0.3: 복원 정본=sidecar)

MCP 클라이언트 설정에서 서버 실행 커맨드를 tap 으로 감싼다. tap 은 child 를 spawn 하고 stdin/stdout 을 바이트 그대로 중계하면서 흘러가는 frame 을 읽기만 한다.

```
before:  "supabase": { "command": "npx", "args": ["-y", "@supabase/mcp-server"] }
after:   "supabase": { "command": "agent-receipt",
                       "args": ["mcp-tap", "--server-name", "supabase",
                                "--log-dir", "/abs/path/.agent-guard/tap", "--",
                                "npx", "-y", "@supabase/mcp-server"] }
```

- `--` 뒤가 원본 커맨드 전체. `--log-dir` 는 **install 이 굽는 절대경로**(§5.0 · CWD 의존 금지).
- **복원 정보의 정본은 sidecar**(`.agent-guard/tap/wrapped.json`). 남의 설정 파일에 넣는 커스텀 키는 클라이언트 스키마 검증·동기화 도구가 지울 수 있어 정본이 될 수 없다(3차 결정 3). 감싼 항목 감지는 `command == agent-receipt && args[0] == mcp-tap` 패턴으로.
- **stderr 는 손대지 않는다.** 파싱도 기록도 하지 않고 그대로 통과.
- **env 는 child 에 전달만 한다.** tapMeta·cmdHash 입력·레코드 어디에도 기록하지 않는다(MCP 설정의 env 블록은 관례적 시크릿 통로 · 3차 결정 5).

### 4.2 설치 대상 (v0.3 정정: 실측 기준)

| 스코프 | 파일 | 비고 |
|---|---|---|
| 프로젝트 공용 | `./.mcp.json` | v1 기본 대상 |
| Cursor(프로젝트) | `./.cursor/mcp.json` | v1 기본 대상 |
| Claude Code(사용자) | `~/.claude.json` 의 mcpServers | **주의: 앱이 살아서 다시 쓰는 큰 상태 파일.** 명시 `--config` + 앱 종료 안내 후에만. 수정=전 프로젝트 영향 경고 의무 |
| Claude Desktop | `claude_desktop_config.json` (OS별) | 명시 `--config` 로 |

- `tap install` 은 기본 **미리보기**, `--write` 에서만 기록(capture install 관례). 멱등: 이미 감싼 서버는 건너뛰고 기존 다른 설정은 보존.
- `--write` 시 sidecar 에 {client, configPath, serverName, original, configHash, logDir} 기록. `tap uninstall --write` 는 sidecar 의 original 로 정확 복원(미리보기에서 복원 diff 먼저).
- **설정 자기봉인:** install 이 서버 블록의 정규화 해시(configHash)를 sidecar 에 기록하고 runtime 인자로도 굽는다. done 시점에 현재 설정을 재계산해 불일치면 coverage 에 drift 로 표기(§9).
- `--write` 직후 핸드셰이크 스모크 안내 의무: `agent-receipt tap probe` (§13).

### 4.3 킬 스위치

`AGENT_RECEIPT_TAP_OFF=1` 이면 기록 파이프라인을 끄고 가능하면 `bypass` 마커 1줄만 남긴 뒤 순수 중계로 동작한다. 몰래 우회는 없다(마커가 남는다).

## 5. 레코드 스키마 `tap/1`

### 5.0 파일 배치 (v0.3 신설: 동시 세션 안전)

- 저장 위치: `<logDir>/<server>-<pid>.jsonl` (append-only). logDir 기본 = `<repo>/.agent-guard/tap/`.
- **서버·프로세스 단위 파일**: 같은 서버를 여러 클라이언트 세션이 동시에 띄워도(각자 자기 tap) 체인이 섞이지 않는다. 한 파일의 쓰기 주체는 자기 tap 프로세스 하나뿐.
- 체인은 **파일 단위로 연속**: 부팅 시 파일이 이미 있으면(pid 재사용) 마지막 유효 레코드에서 prevHash/seq 를 이어받는다(capture tailRecord 패턴). 파일 최초 생성 시에만 seq=0.
- 오래된 부팅 파일 정리는 v1.1 로테이션과 함께(append-only 체인 절단 문제라 세그먼트-링크 설계 필요).
- `.agent-guard/` 전체가 gitignore 대상이라 tap 로그는 커밋되지 않는다. isToolOutput 에 `tap/` 경로 등록(자기 장부를 "미기록 변경"으로 오탐하는 0.11.2 계열 사고 방지).

### 5.1 tapMeta (부팅마다 1회)

```json
{
  "schemaVersion": "tap/1", "kind": "tapMeta",
  "seq": 0, "prevHash": null, "entryHash": "sha256:...",
  "ts": "2026-07-08T12:00:01.203Z",
  "tapVersion": "0.20.2", "digestAlg": "jcs/sha256",
  "bootId": "b7f3a1c2-18344", "sessionId": null,
  "server": { "name": "supabase", "cmdHash": "sha256:...", "transport": "stdio" },
  "configHash": "sha256:...", "logDir": "/abs/path/.agent-guard/tap"
}
```

- `digestAlg` 는 세션당 1회(매 record 반복 금지). 벡터 전수 통과 시만 `jcs/sha256`(실패 시 `sorted/1` 강등 · `src/jcs.ts` 규율).
- `bootId` = 부팅 식별자. 정상 종료 시 `{"kind":"shutdown","clean":true}` 레코드를 마지막에 남긴다. **다음 부팅의 tapMeta 앞에 shutdown 이 없으면 직전 비정상 종료의 구조적 자백**(3차 결정 8).
- `cmdHash` = [command, ...args] 의 JCS digest. **env 불포함**(결정 5).
- initialize 응답 관측 시 `{"kind":"serverInfo","protocolVersion":...}`, 첫 tools/list 응답 시 `{"kind":"toolSurface","count":N,"digest":"sha256:..."}` 레코드를 추가로 남긴다(레코드는 불변, 갱신은 새 줄).

### 5.2 호출 record (기본형)

```json
{
  "schemaVersion": "tap/1", "kind": "call",
  "seq": 17, "prevHash": "sha256:...", "entryHash": "sha256:...",
  "ts": "2026-07-08T12:03:44.812Z", "server": "supabase",
  "rpc": { "id": "42", "method": "tools/call" },
  "tool": { "name": "execute_sql", "argKeys": ["query"], "argsDigest": "sha256:...", "argBytes": 512 },
  "result": { "status": "ok", "isError": false, "resultDigest": "sha256:...", "resultBytes": 2048, "latencyMs": 130 },
  "class": ["db-write"], "markers": []
}
```

| 필드 | 규칙 |
|---|---|
| `ts` | 벽시계 · **reported 등급**(자가보고 라벨). 순서의 진실은 seq. |
| `argsDigest` | **파스 후 값 기준**(와이어 바이트 아님) JCS 정규화 sha256. 인자 부재는 null(부재도 정보 · 빈 객체로 위조 안 함). 원문 즉시 폐기. canonicalize 실패(비유한수 등) 시 argsDigest 생략 + `canonFailed:true` + 원시 프레임 frameDigest 로 대체(3차 결정 6). |
| `argKeys` | 최상위 키 이름만, 최대 32개, 깊이 1. 값 절대 없음. |
| `result.status` | ok / error(JSON-RPC error) / opaque(파싱 불가) / orphan(짝 없는 응답) |
| `latencyMs` | rpc.id 페어링으로 계산. pending 맵 **상한 4096 + TTL 5분**, 초과·만료는 `unpaired` 마커(3차 결정 9). |
| `class` | 자문(advisory) 분류(§8). 판정 입력 아님. |
| `markers` | degraded / dropped:N / bypass / unpaired / orphan-response / canon-failed ... |

### 5.3 notification / opaque

- notifications(id 없음): `kind:"notification"`, method 만 기록. **동일 method 연속은 병합 대상**(§5.5 · 진행률 스팸 대응).
- 파싱 실패 frame: `kind:"opaque"`, bytes·frameDigest 만. 절대 차단하지 않고 통과.

### 5.4 해시체인

capture 와 동일 규약: entryHash = sha256(자신 제외 결정론 직렬화), prevHash = 직전 record 의 entryHash. `tap verify` 가 변조·삭제·재배열·seq 갭·병합 산술(repeat == lastSeq-firstSeq+1)을 검사한다. 기록 실패는 조용히 사라지지 않고 가능한 시점에 degraded/dropped 마커로 자백한다.

### 5.5 병합(coalescing) · 샘플링 금지의 대안

**샘플링은 도입하지 않는다**(감사는 전수 · read 홍수로 write 를 떨구게 유도하는 공격면 차단). 대신 무손실 압축:

- **연속**이고 **argsDigest·결과(digest·status)까지 전부 동일**한 **읽기류** 호출(fs-read · db-read · resources/read · prompts/get · list 류)과 **동일 method 연속 notification** 은 한 record 로 접는다: `repeat:N + firstSeq/lastSeq + firstTs/lastTs`, 나머지 필드 동일.
- 쓰기·실행·네트워크·배포·publish 클래스는 절대 병합하지 않는다(동일 INSERT 100번은 100번의 효과).
- **닫힘 조건은 입력-사건 3개뿐**: (a) 다른 레코드 도착 (b) 스트림 종료/child 종료 (c) repeat 상한 1000 도달. **시간 기반 닫힘 금지**(I4 결정론 보호 · 3차 결정 7).
- 크래시 시 열린 병합 창은 유실될 수 있다(읽기류 한정 · 체인 무결 유지). 그 크래시 자체는 bootId/shutdown 부재로 자백된다(§5.1 · 위협 모델 (e)).
- 과부하 최후선은 §7 의 dropped:N 자백 경로(병합=평시 부피, 드랍=비상 자백 · 역할 분리).

### 5.6 세션 경계 = 커서 스냅샷 (v0.3 신설 · "초기화" 폐기)

- tap 은 클라이언트가 띄운 **장수 프로세스**라 begin 이 로그를 초기화할 수 없다(truncate=열린 핸들·체인 파괴 / 이중 계상 위험).
- 답: `begin` 이 `<logDir>/cursor.json` 에 **파일별 (lastSeq, lastEntryHash) 커서**를 스냅샷한다. `done`/`receipt` 는 커서 초과분만 집계하고 tapSummary 에 창 경계를 명시한다. 체인은 자르지 않는다.
- begin 경계에 걸친 열린 병합 창은 창 전체가 커서 이후 영수증에 귀속된다(레코드 단위 귀속 · 정직 명기).

## 6. JSON-RPC 처리 규칙

1. **프레이밍:** 개행 구분 JSON. 부분 frame 버퍼링, 버퍼 상한 8MB 초과 시 스트리밍 sha256 으로 digest 만 만들고 opaque 처리(중계는 계속). JSON-RPC 배열(배치) frame 은 요소별로 기록(신 MCP 스펙은 배칭 제거·방어적 처리).
2. **기록 대상(v1):** initialize(서버 정보) · tools/list(표면 스냅샷) · tools/call(본체) · resources/read · prompts/get(이름·digest 만) · notifications(method 만). 그 외 method 는 method 명만.
3. **페어링:** rpc.id 기준 request-response 매칭(맵 기반 · 순서 뒤섞임 안전 · 상한 4096 + TTL 5분).
4. **양방향 무수정:** frame 을 수정·재직렬화하지 않는다. 관측용 파싱은 복사본에서, 원본 바이트는 그대로 흘린다(금지 불변식 I2).
5. **URI 취급(resources/read 등) · 스킴 이원화:** URI 는 자격증명일 수 있다(presigned URL, userinfo).
   - `file://` 은 경로 저장(capture 의 "경로=메타데이터" 선례 · 기존 redact 규칙 적용).
   - 그 외 스킴은 scheme + host 만 저장. http(s) 의 경로·쿼리 미저장.
   - **userinfo 는 전 스킴에서 제거**(0.11.2 secret-in-URL strip 선례의 확장).
   - 항상 원문 URI 의 sha256(`uriDigest`) 병기: "정확히 이 URI 를 읽었다" 주장 검증 가능성 보존(사전 대입 한계는 §11 (d)).

## 7. Fail-open 상태기계

원칙: **기록의 실패는 절대 스트림을 막지 않는다(fail-open). tap 프로세스 자체의 실패는 도구 고장으로 시끄럽게 드러난다**(조용한 사각지대보다 시끄러운 고장이 감사 도구로서 옳다). 탈출구는 킬 스위치(§4.3).

상태: SPAWNING → ACTIVE → (기록 오류 시) DEGRADED → (회복 시 dropped:N 마커와 함께) ACTIVE → (child 종료/시그널) FLUSH → exit.

- 기록은 비동기 인메모리 큐(상한 1,000건). 디스크가 느리면 frame 을 기다리게 하지 말고 record 를 드랍하라(드랍은 dropped:N 으로 자백).
- 어떤 frame 처리 예외도 중계 루프를 죽일 수 없다(try/재개 + DEGRADED 전이).
- SIGINT/SIGTERM 은 child 로 전달, child 의 exit code 를 그대로 전파. **FLUSH(상한 2초)는 exit code 전파를 지연시키지 않는 최선노력**(3차 제약).
- child 기동 실패 시 child 의 exit code 로 종료(원인 stderr 그대로).

## 8. 행위 분류 (advisory)

목적: risk/inbox/guard 가 소비할 신호. **판정(verdict) 입력이 아니며 점수도 아니다.**

| class | 판별 |
|---|---|
| fs-write / fs-read | 도구명 렉시콘(write_file/edit vs read_file/list) |
| exec | run_command/bash/execute 류 |
| network | fetch/http/search 류, 인자에 URL 스킴(호스트만 기록·경로·쿼리 미저장) |
| db-read / db-write | 서버 힌트 + 알려진 키(query 등) 값의 **선두 토큰 파스**(SELECT vs INSERT/UPDATE/DELETE/DDL · 0.20 lead-token 규율 계승) |
| deploy / publish | 도구명·서버명 렉시콘 |
| unknown | 기본값 |

정직 표기: db-write 판별의 선두 토큰 파스는 값을 메모리에서 잠깐 본다(digest 계산과 동일 수명). 디스크에는 절대 남지 않는다.

## 9. 영수증·대사(reconcile) 통합

`done`/`receipt` 는 커서 이후 tap 레코드가 있으면 `tapSummary` 블록을 additive 로 동봉한다(actionsSummary 동형 · receiptHash 제외 관례).

```json
"tapSummary": {
  "records": 214, "byServer": {"supabase": 120}, "byClass": {"db-write": 3},
  "degraded": false, "dropped": 0, "window": {"files": {"supabase-1234.jsonl": {"fromSeq": 100, "toSeq": 314}}},
  "coverage": { "expectedServers": ["supabase","github"], "observedServers": ["supabase"], "missing": ["github"], "excluded": [], "configDrift": [] }
}
```

대사 규칙(v0.3.1 정정 · 구현이 드러낸 모순의 정직 반영: tap 은 값 미저장(G4)이라 tools/call 의 경로를 모른다. 경로 수준 대사는 tap 으로 불가능하며, 가능한 척하지 않는다):
1. git 변경 경로의 경로-수준 대사는 capture 전용 유지(tap 은 경로 무관측이라 참여 불가 · 정직 명기).
2. 클래스-수준 신호: tap 창에 fs-write 관측이 있는데 git 변경(touched+untracked)이 0 이면 사실 신호 1줄(생성후삭제/ignored/저장소 밖 가능). db-write 관측은 done 의 forbid_actions warn-only 라인이 커버.
3. capture 와 tap 의 카운트는 합산하지 않는다(actions=capture · tapSummary=tap 분리 표기) → 이중 계상이 구조적으로 불가능.
4. coverage.missing (설치 기록엔 있는 서버인데 이번 창에 레코드 0) → `no-records-in-window` 사실 신호. 미사용과 살해를 구분할 수 없음을 정직 명기(중립 어휘 · 비난 아님).
5. coverage.excluded → "침묵 없는 제외": 선언·기록되고 share-proof 에 렌더, 정책 키(opt-in)로 제외 0 요구 가능. 판단 주체는 채택자.

- **coverage.expectedServers 의 정본 = install 시점 sidecar**(런타임 재파싱은 configDrift 신호와 역할 분리 · 3차 결정 10).
- 증거 등급: tap record 는 **controls 증거위계의 C(자가 관측)** · capture 와 동급. **evidencekernel 의 검사 등급(assuranceGrade A/B/C)과는 별개 개념**이니 혼동 금지(3차 결정 11). 등급 상승은 증인(CI/Rekor)의 일이지 tap 의 일이 아니다.

## 10. 정책 연동 (v1 범위)

- forbid_actions 클래스 판별의 입력 소스로 tap class 를 추가하되 **v1 은 warn 까지만**. tap 경로의 deny 는 비-목표(§2). **warn-only 는 회귀 테스트로 잠근다**(가드 오탐 표본 재회의 전 deny 금지 · 3차 결정 12).
- inbox 필터에 "tap db-write 있음" 류 사실 조건명 프리셋 추가(판단어 금지 테스트 대상).

## 11. 위협 모델 발췌

| 공격 | 대응 | 잔여 한계(정직) |
|---|---|---|
| (a) 에이전트가 tap 설정 수정 | 설정 파일 denied_paths 권장 + configHash(sidecar) + done 시 drift 표기 | 세션 시작 전 선수정은 계약 diff·리뷰의 몫 |
| (b) tap 프로세스 살해/제거 | 파이프 단절=도구 고장으로 표면화 + no-records-in-window 신호 | 사용자 스스로의 uninstall 은 막지 않음(성실성 증빙이지 악의 탐지기 아님) |
| (c) 시계 조작 | ts 는 reported 라벨, 순서는 seq, 시간 앵커는 Rekor(anchor --upload) | 앵커 없는 영수증의 절대 시각은 자가보고 |
| (d) argsDigest/uriDigest 사전 대입 | 로그 로컬+gitignore · audit-pack 은 redact · 민감 서버는 선언된 --except | 원리상 차단 불가(솔트/HMAC 은 제3자 검증을 죽임) |
| (e) 크래시로 열린 병합 창 유실 | bootId + cleanShutdown 부재로 다음 부팅이 자백 | 유실된 레코드 자체는 복구 불가(읽기류 한정·체인 무결 유지) |

## 12. 불변식 & 테스트 계획

- **I1 byte-invariant:** tap 미사용 영수증은 기존과 바이트 동일(골든 스냅샷).
- **I2 무수정 중계:** 입력 스트림 == 출력 스트림 바이트 동일(퍼저로 임의 바이트 주입).
- **I3 값 미저장:** fixture 인자·**env** 에 심은 카나리아 시크릿이 tap 로그 어디에도 없음을 grep 으로 강제.
- **I4 결정론:** 같은 입력 스트림 → ts 제외 동일 record 열(병합 포함).
- **I5 fail-open:** 기록 오류 주입 시 중계 무결 + dropped 마커.
- **I6 판정 격리:** tap 데이터가 verdict 계산에 유입되지 않음 + warn-only 잠금.
- **I7 커서 창 비중첩:** 한 tap 로그 위 begin/done 2회 → 두 영수증 구간 비중첩·합계 일치.
- **I8 경로 절대성:** 비우호 CWD(읽기전용)에서도 --log-dir 에 정상 기록(favorable-CWD 함정 방지).
- **I9 닫힘 결정론:** 병합 닫힘에 시간 조건 없음(코드·테스트로 잠금).
- dogfood: 가짜 MCP 서버 fixture + 변조 교보재(tampered chain) 상시 유지.

## 13. CLI 표면 & 로드맵

```
agent-receipt mcp-tap --server-name <n> --log-dir <abs> [--config-hash <h>] -- <원본 커맨드...>
agent-receipt tap install   [--write] [--config <path>] [--except <name>...]   # 기본 미리보기 · 제외는 선언·기록
agent-receipt tap uninstall [--write] [--config <path>]                        # sidecar 원본으로 정확 복원
agent-receipt tap status                                                       # sidecar + 로그 요약(부팅·클린종료)
agent-receipt tap show      [--by server|class]                                # 카운트(중립)
agent-receipt tap verify                                                       # 해시체인·병합 산술 무결성
agent-receipt tap probe     [--server <n>]                                     # 핸드셰이크 스모크(initialize 왕복)
```

- v1(이 문서): stdio 관측 · tap/1 · 커서 경계 · reconcile 통합 · warn 신호. 지원 선언은 POSIX+WSL 실측분만(Windows 네이티브는 스모크 후).
- v1.1: HTTP/SSE 전송 · record 로테이션(세그먼트-링크).
- v2: 게이트웨이-로그 어댑터(기업 게이트웨이 감사로그를 tap/1 로 정규화 ingest) · 관측 소스 플러그인 스펙의 씨앗.

## 14. 결정 이력

- **2차 회의(확정 4):** ① 정규화=자체 구현 JCS(RFC 8785)+공식 벡터 동결·명칭 강등 규율 ② 샘플링 금지·읽기류 무손실 병합 ③ --except 는 "침묵 없는 제외" ④ URI 스킴 이원화+uriDigest+userinfo 제거. 관통 원칙: 숨기지 말고 라벨하라.
- **3차 회의(코드 실측 수정 14 · 2026-07-08):** 1 세션 경계=커서 스냅샷(초기화 폐기) · 2 --log-dir 절대경로 · 3 복원 정본=sidecar · 4 설치 대상 표 정정(~/.claude.json 실측·라이브 파일 경합 경고) · 5 env 미기록 · 6 canonFailed 폴백 · 7 병합 닫힘 3조건+notifications 포함 · 8 bootId/cleanShutdown 자백 · 9 pending 상한 4096 · 10 expectedServers=sidecar 정본 · 11 등급="controls 위계의 C" 특정 · 12 warn-only 테스트 잠금 · 13 구현 순서(JCS 첫 커밋)+"신규 의존성 0 원칙" 문구 정정(기존 deps 3개 실재) · 14 본 문서의 repo 커밋.
- 이월: record 로테이션(v1.1) · witness/deploy 조인/evidence-repo/traceparent/ambient 는 각각 별도 회의.
