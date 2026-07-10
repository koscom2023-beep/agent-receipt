# Agent Receipt Format 명세 (초안 v1.1)

_Promptia Labs · AI 작업 감사 영수증 공개 형식 · 2026-07_

> **목적.** 이 문서는 "AI 코딩 에이전트 변경 감사 영수증"의 형식을 **도구와 독립적으로** 정의합니다. 목표는 제3자(감사인, 고객, 규제기관, 또는 다른 벤더)가 **agent-receipt 구현을 신뢰하지 않고도** 영수증을 검증하고 발행할 수 있게 하는 것입니다. 이것이 이 형식을 한 도구의 출력이 아니라 *표준* 후보로 만듭니다.
>
> **규범 우선순위.** 규범(normative) 원천은 영어판 `SPEC.md`와 참조 구현(`@promptia-labs/agent-receipt` v0.24, `schemaVersion` `"1.1"`)입니다. 이 한국어 문서는 이해를 돕는 번역이며, 해석이 갈리면 **영어판이 우선**합니다. 바이트 단위 적합성은 `test/vectors/vectors.json`의 테스트 벡터로 고정됩니다(8장).

---

## 1. 용어

- **Receipt (영수증)**: 한 시점의 git 작업 스냅샷과 판정을 담은 JSON 객체.
- **Seal (봉인, `contentHash`)**: 영수증 본문을 덮는 SHA-256 무결성 해시.
- **Proof Bundle (증명 번들)**: 영수증에 선택적 서명, 앵커, 증거 파일을 묶은 폴더.
- **Issuer (발행자)**: 영수증을 만드는 주체(팀의 CI).
- **Verifier (검증자)**: 영수증을 확인하는 주체(감사인, 고객, 규제기관, CI).

## 2. Receipt 객체

JSON 객체. 주요 필드(참조 구현 기준):

| 필드 | 형 | 봉인 | 설명 |
|---|---|:--:|---|
| `schemaVersion` | string | 아니오 | 형식 버전. 현재 `"1.1"`. 봉인에서 제외(버전 표식이라 해시가 이 값에 무관). |
| `kind` | string | 해당없음 | 영수증 종류(작업 / 검증). |
| `headHash` | string | 예 | git HEAD 커밋 해시. |
| `branch` | object | 예 | `{ current, expected, ok }`. |
| `contractId` | string | 예 | 작업 계약 식별자. |
| `touched` / `staged` / `untracked` / `outOfScope` | string[] | 예 | 변경 / 스테이징 / 미추적 / 범위밖 경로(봉인 전 정렬). |
| `deniedHits` | string[] | 예 | deny 규칙에 걸린 경로(정렬). |
| `magnitude` | object | 예 | 변경 규모(파일 수, added, deleted, newFiles). |
| `criticalPaths[]` | object[] | 예 (touched만) | 고위험 경로 glob과 히트. 봉인은 `criticalTouched`(평탄화, 정렬)를 사용. |
| `checks[]` | object[] | 예 | 검사 결과. 봉인은 `name:exitCode:requiredExit:ok` 문자열(정렬)을 사용. |
| `ok` | boolean | 예 | **최종 합격/불합격.** (v1.1부터 봉인) |
| `violations` | string[] | 예 | 위반 목록(정렬, 없으면 `[]`). |
| `verdict` | object? | 예 (있을 때) | 세션 판정. `done`이 부착한 뒤 재봉인. |
| `contractSnapshot` | object? | 예 (있을 때) | 계약 최소 필드와 `contractHash`. |
| `actions[]` | object? | 예 (다이제스트) | capture(git 너머 행위). 봉인은 `actionsDigest = "sha256:" + sha256(stableStringify(actions))`를 사용. |
| `reconciliation` | object? | 예 (다이제스트) | git 대 capture 대사. 봉인은 `reconciliationDigest`를 사용. |
| `contentHashes[]` | object? | 예 (있을 때) | touched 파일의 sha256(내용은 미저장). 봉인은 `path:sha256`(정렬)을 사용. |
| `actionsSummary` / `tapSummary` | object? | 아니오 | 요약 / 관측 메타데이터(봉인 제외). |
| `environment` / `timestamp` / `measuredFrom` / `disclosure` | 해당없음 | 아니오 | 출처, 시간, 한계(머신과 시간에 따라 변해서 제외). |
| `contentHash` | string | 해당없음 | 봉인값 자체(`"sha256:" + hex`). |

## 3. Seal (`contentHash`) 계산 (규범)

제3자는 봉인을 재현하려면 정확히 다음대로 해야 합니다.

**3.1 정규화 (`stableStringify`).** `JSON.stringify`를 쓰되, **모든 객체의 키를 재귀적으로 사전순 정렬**합니다. 배열은 순서를 유지합니다(호출부가 미리 정렬해 넣음). 숫자와 문자열 인코딩은 표준 ES `JSON.stringify`를 따릅니다. _(참고: 이는 RFC 8785 JCS와 유사하나 **동일하지 않습니다**. 이 형식의 봉인은 `stableStringify`가 규범입니다. 별도의 로그 / 원장 계층은 RFC 8785 JCS를 씁니다.)_

**3.2 봉인 preimage (payload).** 다음 키를 가진 객체를 만듭니다(선택 키는 존재할 때만 포함):

```
{
  headHash,
  touched: sort(touched), staged: sort(staged),
  untracked: sort(untracked), outOfScope: sort(outOfScope),
  deniedHits: sort(deniedHits),
  magnitude,
  criticalTouched: sort(flatten(criticalPaths[].touched)),
  checks: sort(checks.map(c => `${c.name}:${c.exitCode}:${c.requiredExit}:${c.ok}`)),
  ok,
  violations: sort(violations ?? []),
  branch, contractId,
  verdict?            // present only when present
  contractSnapshot?   // present only when present
  actionsDigest?         = "sha256:" + sha256(stableStringify(actions))        // only when actions present and non-empty
  reconciliationDigest?  = "sha256:" + sha256(stableStringify(reconciliation)) // only when present
  contentHashes?      = sort(contentHashes.map(c => `${c.path}:${c.sha256 ?? "null"}`)) // only when present
}
```

**3.3 최종.** `contentHash = "sha256:" + hex(sha256(utf8(stableStringify(payload))))`.

**불변식.** `schemaVersion`, `environment`, `timestamp`, `tapSummary`, `actionsSummary`는 봉인에서 제외됩니다. 존재하지 않는 선택 필드는 **키 자체가 없어야** 합니다(하위호환과 바이트 안정성).

## 4. Proof Bundle (폴더 구조)

| 파일 | 필수 | 내용 |
|---|:--:|---|
| `receipt.json` | 예 | 위 Receipt 객체. |
| `anchor.dsse.json` | 선택 | DSSE 봉투: `{ payloadType, payload(base64), signatures:[{ sig(base64), keyid? }] }`. payload는 in-toto Statement(5장). |
| `public.pem` | 선택 | 서명 검증용 ed25519 공개키(SPKI PEM). |
| `anchor.rekor.json` | 선택 | 투명성 로그 사이드카: `{ uuid, verifyUrl, logIndex }`. |
| `evidence/*.json` | 선택 | 검증 영수증(오프라인 replay 대상). |

## 5. Signature (DSSE), 규범

**5.1 Statement.** DSSE payload는 in-toto Statement입니다.

**작업 영수증에 대한 증명 번들**(`share-proof --bundle`과 `attest`가 생성)에서 참조 구현은 predicateType `https://promptia-labs.dev/agent-receipt/ai-work/v0.1`을 씁니다. subject는 다음과 같습니다:

- `{ name: "ai-work-receipt", digest: { sha256: <"sha256:" 접두를 뺀 contentHash> } }`
- `{ name: "git-commit", digest: { gitCommit: <headHash> } }`

predicate는 판정 관련 필드(`ok`, `branch`, `{name, ok}`로 압축한 `checks` 목록)를 담습니다. `subject[0].digest.sha256`이 영수증 `contentHash`(3장)에 묶이고 봉인이 이제 판정 필드를 덮으므로, 영수증 본문이나 판정 중 하나라도 변조하면 이 결합이 깨집니다.

**별도** 경로(`predicate --sign`)는 검증 영수증(research / council / bench)을 predicateType `https://promptia-labs.dev/agent-receipt/claim-verification/v1`로 서명하며, 그 `subject[0].digest.sha256`은 검증 영수증의 `contentHash`입니다. `docs/PREDICATE.md` 참고.

**5.2 PAE (Pre-Authentication Encoding).** 서명 대상 바이트는 DSSE 표준 PAE입니다:
```
"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload
```
**5.3 알고리즘.** ed25519. 서명은 PAE 바이트에 대해 검증합니다. 키는 `public.pem`(SPKI)입니다.

## 6. Verification 절차 (규범)

Verifier는 순서대로:

1. **receipt-parse**: `receipt.json`이 파싱됨.
2. **receipt-hash**: `contentHash`(3장)를 재계산해 대조. **불일치는 반드시 실패**로 처리합니다. `schemaVersion < 1.1`이면 **문구만** "변조, 또는 재발행이 필요한 0.24 이전 형식"으로 완화합니다(상태는 fail 유지: 0.24 이전 영수증은 약한 봉인을 썼으므로 유효로 인정하면 안 됨). `schemaVersion >= 1.1`이면 변조 신호입니다.
3. **dsse-signature / dsse-subject**: `anchor.dsse.json`과 `public.pem`이 있으면, PAE에 대한 ed25519 서명을 검증하고, Statement subject digest가 영수증 `contentHash`와 같은지 확인합니다.
4. **rekor-sidecar**: `anchor.rekor.json`이 있으면 형식을 확인합니다(`uuid` 길이 >= 40, `verifyUrl` 존재). _오프라인, 네트워크 0._
5. **evidence-replay**: `evidence/*.json`이 있으면 각각의 봉인을 재계산합니다.

**종합 판정.** 어떤 검사도 `fail`이 아니면 번들은 통과입니다. **다만, 오프라인 검사가 통과했다고 그 자체로 "생성 시점 그대로"를 뜻하지는 않습니다.** 봉인은 비밀 없는 SHA-256이라 누구나 재계산할 수 있고, 자가관리 DSSE 키는 발행자가 쥐고 있으므로, 둘 다 위조된 번들에도 붙어 있을 수 있습니다. 따라서 Verifier는 **독립적인 제3자 앵커(Rekor 항목)**가 있을 때만 더 강한 "생성 시점 그대로" 표현을 써야 하고, 그마저도 실제 확인은 사람이 투명성 로그 링크를 여는 것입니다(이 명령은 오프라인). 그 외에는 결과를 **자가 주장 무결성**으로 표현합니다.

**Exit 코드.** `0` = 통과, `1` = 검증 실패, `2` = 입력 오류.

## 7. 신뢰 모델 (정직 고지)

- 자가관리 키 서명은 **무결성과 키 소유**를 보이지만 **신원**은 아닙니다. 신원은 외부에서 옵니다(온라인 확인된 투명성 로그 항목, 또는 핀된 키).
- Rekor 사이드카의 존재만으로는 항목의 실재나 바인딩을 증명하지 않습니다(온라인 확인은 별개).
- 이 형식은 **컴플라이언스 검토용 증거**이지 컴플라이언스 보장이 아닙니다.

## 8. 표준화 To-Do (정식 공개 전)

1. **적합성 테스트 벡터**: `test/vectors/vectors.json`은 참조 구현이 생성한 `(receipt, expectedContentHash)` 쌍을 담습니다(`node test/vectors/generate.mjs`). 다른 구현은 각 `receipt`에 대해 봉인(3장)을 재계산해 `expectedContentHash`와 같은지 확인할 수 있습니다. CI의 `test/receipt-vectors.test.mjs`가 이를 재검증하며, 봉인의 우발적 변경도 함께 막습니다.
2. **스펙 URL 네임스페이스**: 이 스펙은 `receipt.promptia.kr/spec`에 게시됩니다. predicateType URI는 Promptia Labs 도메인(`promptia-labs.dev`)에 있습니다: `.../agent-receipt/ai-work/v0.1`와 `.../agent-receipt/claim-verification/v1`.
3. **정식 JSON Schema**: 권위 있는 스키마를 배포(구현의 `claimSchema` 확장).
4. **버전 정책**: `1.1`에서 `1.x`는 additive이며, 봉인 preimage(3.2)의 변경은 major 버전입니다.
5. **개방 거버넌스**: 표준은 통제를 나눌 때만 채택되므로, 거버넌스 모델을 명시합니다.

> 이 초안은 코드를 읽어 파악한 실제 구현을 반영합니다. 8.1의 테스트 벡터가 바이트 단위로 고정하니, 정식으로 확정하기 전에 그것으로 검증하세요.
