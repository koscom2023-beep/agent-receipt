import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { InTotoStatement } from "./attest.js";
import { LIMIT_NOTE } from "./disclosure.js";

// R4: verification receipt(research/council/bench)용 in-toto predicate 를 정식 명명·공개.
// 기존 ai-work predicate(attest.ts)의 형제 — "AI 주장 검증"이라는 새 카테고리에 표준 타입명을 선점한다.
//
// 정직(회의 D3): predicateType URI 는 fetch 대상이 아니라 in-toto 네임스페이스 식별자다(호스팅 레지스트리 약속 아님).
//   스키마는 repo(docs/PREDICATE.md)에 공개해 실체화한다.
export const CLAIM_VERIFICATION_PREDICATE_TYPE = "https://promptia-labs.dev/agent-receipt/claim-verification/v1";

interface VReceiptShape {
  kind?: unknown;
  receiptId?: unknown;
  contentHash?: unknown;
  surface?: unknown;
  verdict?: unknown;
  subject?: unknown;
  summary?: unknown;
  provenance?: unknown;
  tool?: unknown;
}

// 순수함수: Verification Receipt → in-toto Statement v1(claim-verification predicate).
// subject.digest.sha256 = 봉인된 영수증의 contentHash(변조 시 digest 불일치). 입력 원문/값은 노출하지 않는다.
export function buildClaimVerificationStatement(r: VReceiptShape): InTotoStatement {
  const contentHash = typeof r.contentHash === "string" ? r.contentHash.replace(/^sha256:/, "") : "";
  const subjectName = typeof r.subject === "string" && r.subject ? r.subject : "verification-receipt";
  const toolVersion = r.tool && typeof r.tool === "object" ? (r.tool as { version?: unknown }).version ?? null : null;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: subjectName, digest: { sha256: contentHash } }],
    predicateType: CLAIM_VERIFICATION_PREDICATE_TYPE,
    predicate: {
      tool: "agent-receipt",
      toolVersion,
      surface: r.surface ?? null, // research | council | bench
      receiptId: r.receiptId ?? null, // 타임스탬프 제외 크로스시스템 대조키
      verdict: r.verdict ?? null, // pass | fail
      summary: r.summary ?? null, // 검사 집계(verified/failed/… 또는 bench 지표)
      provenance: r.provenance ?? null, // {verified, reported} — 자가보고 분리
      disclosure: LIMIT_NOTE,
      note: "결정론·비-LLM 검사의 결과 기록(증적)이지 결론의 진위 증명이 아니다. predicateType 은 상호운용용 타입명이며 호스팅 레지스트리를 약속하지 않는다. 스키마: docs/PREDICATE.md.",
    },
  };
}

// 기계판독 predicate 스키마(코드가 곧 스펙 — 남이 채택할 표면).
export function claimVerificationPredicateSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "agent-receipt claim-verification predicate",
    predicateType: CLAIM_VERIFICATION_PREDICATE_TYPE,
    description: "결정론 검사기(agent-receipt)가 주장/근거를 검증한 결과의 in-toto predicate. subject.digest.sha256 = 봉인 Verification Receipt 의 contentHash.",
    type: "object",
    required: ["tool", "surface", "verdict"],
    properties: {
      tool: { const: "agent-receipt" },
      toolVersion: { type: ["string", "null"] },
      surface: { type: "string", enum: ["research", "council", "bench"] },
      receiptId: { type: ["string", "null"], description: "타임스탬프 제외 결정론 대조키" },
      verdict: { type: "string", enum: ["pass", "fail"] },
      summary: { type: ["object", "null"] },
      provenance: { type: ["object", "null"], description: "{verified, reported} — 자가보고 분리" },
      disclosure: { type: "string" },
      note: { type: "string" },
    },
  };
}

/**
 * `agent-receipt predicate --receipt <verification-receipt.json> [--schema]`
 *  Verification Receipt 를 claim-verification/v1 in-toto Statement 로 감싸 stdout 출력(전송/서명 없음).
 *  --schema: predicate JSON Schema 출력. exit 0 / 2.
 */
export function runPredicate(receiptArg: string | undefined, opts: { schema?: boolean } = {}): never {
  if (opts.schema) {
    process.stdout.write(JSON.stringify(claimVerificationPredicateSchema(), null, 2) + "\n");
    process.exit(0);
  }
  if (!receiptArg) {
    console.error("predicate: --receipt <verification-receipt.json> 가 필요합니다 (또는 --schema 로 predicate 스키마 출력).");
    process.exit(2);
  }
  const p = isAbsolute(receiptArg) ? receiptArg : join(process.cwd(), receiptArg);
  if (!existsSync(p)) {
    console.error(`predicate: 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  let receipt: VReceiptShape;
  try {
    receipt = JSON.parse(readFileSync(p, "utf8")) as VReceiptShape;
  } catch {
    console.error(`predicate: JSON 파싱 실패: ${receiptArg}`);
    process.exit(2);
  }
  if (receipt.kind !== "verification-receipt" || typeof receipt.contentHash !== "string") {
    console.error("predicate: verification-receipt 가 아닙니다(kind='verification-receipt'·contentHash 필요). research/council/bench --out 으로 생성한 영수증을 주세요.");
    process.exit(2);
  }
  const statement = buildClaimVerificationStatement(receipt);
  process.stdout.write(JSON.stringify(statement, null, 2) + "\n");
  process.stderr.write(`note: in-toto Statement(${CLAIM_VERIFICATION_PREDICATE_TYPE})를 stdout 으로만 출력 — 전송/서명 없음. DSSE 서명·Rekor 봉인은 anchor 경로.\n`);
  process.exit(0);
}
