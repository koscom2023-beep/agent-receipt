# in-toto predicate: `claim-verification/v1`

agent-receipt 는 두 종류의 in-toto predicate 를 발행한다.

| predicate | 대상 | 정의 |
|-----------|------|------|
| `…/agent-receipt/ai-work/v0.1` | AI 작업 영수증(Work Receipt) | `src/attest.ts` |
| **`…/agent-receipt/claim-verification/v1`** | **주장 검증 영수증(Verification Receipt)** | `src/predicate.ts` |

이 문서는 후자 — **AI 가 내놓은 주장/근거를 결정론으로 검증한 결과**를 공급망 증명 생태계(in-toto/DSSE/Sigstore)에 표준 형태로 얹기 위한 predicate 다.

## predicateType

```
https://promptia-labs.dev/agent-receipt/claim-verification/v1
```

## Statement 형태

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    { "name": "<검증 대상 query/question>", "digest": { "sha256": "<봉인 Verification Receipt 의 contentHash>" } }
  ],
  "predicateType": "https://promptia-labs.dev/agent-receipt/claim-verification/v1",
  "predicate": {
    "tool": "agent-receipt",
    "toolVersion": "0.15.x",
    "surface": "research | council | bench",
    "receiptId": "<타임스탬프 제외 결정론 대조키>",
    "verdict": "pass | fail",
    "summary": { "...": "검사 집계(verified/failed/… 또는 bench 지표)" },
    "provenance": { "verified": {}, "reported": null },
    "disclosure": "...",
    "note": "..."
  }
}
```

`subject.digest.sha256` = 봉인된 Verification Receipt 의 `contentHash`. 영수증이 한 글자라도 바뀌면 이 digest 와 어긋나 변조가 드러난다.

## 생성

```bash
# 1) 검증 → Verification Receipt 봉인
agent-receipt research verify --file report.json --out receipt.json
# 2) 그 영수증을 claim-verification/v1 Statement 로 명명
agent-receipt predicate --receipt receipt.json          # Statement 출력
agent-receipt predicate --schema                         # predicate JSON Schema 출력
# 3) (선택) DSSE 서명 + Rekor 투명로그 봉인
agent-receipt anchor --upload
```

## 정직한 경계

- **predicateType URI 는 in-toto 네임스페이스 식별자이지 fetch 대상이 아니다.** 이 URL 을 호스팅 레지스트리로 서빙한다는 약속이 아니다 — 스키마의 실체는 이 repo(`docs/PREDICATE.md` + `src/predicate.ts`)에 있다.
- predicate 는 **결정론 검사의 결과 기록(증적)**이지 결론의 진위 증명이 아니다. `provenance.reported` 는 자가보고이며 모델·프롬프트 사용이나 실행 연결을 증명하지 않는다.
- 로컬 자가서명은 "위조 불가"가 아니라 "변조를 알아챌 수 있는(tamper-evident) 출처 기록"이다. 강한 제3자 보증은 Rekor 투명로그(`anchor --upload`)에 위임한다.
