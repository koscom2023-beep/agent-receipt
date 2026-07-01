import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { SCHEMA_VERSION } from "./evidencekernel.js";
import { installedVersion } from "./version.js";

// ── Verification Receipt (증적 체계·L5 씨앗) ──
// 검증을 휘발 stdout 이 아니라 durable·링크가능·재현가능한 아티팩트로 봉인한다.
// Claim → Verification → Receipt → Provenance 를 하나로: 무엇을·언제·무엇으로(입력해시)·어느 버전이·
//   어떤 provenance 아래 검증했는지 + self contentHash(변조탐지). provenance 는 기록(자가보고)이지 판단 아님.

export interface VReceiptInput {
  surface: string; // "research" | "council"
  inputFile: string;
  inputRaw: string; // 입력 원문(해시 대상)
  subject: string; // query / question
  provenance: unknown; // 리포트가 담은 provenance(자가보고·기록) 또는 null
  results: unknown[]; // surface 별 claim/decision 결과
  summary: Record<string, number>;
  verdict: "pass" | "fail";
  verifiedAt: string; // 호출부가 타임스탬프 주입(테스트 결정론)
}

// 봉인 본문 + self contentHash 계산(순수·결정론: 같은 입력·같은 verifiedAt → 같은 hash).
export function buildVerificationReceipt(o: VReceiptInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    kind: "verification-receipt",
    surface: o.surface,
    verifiedAt: o.verifiedAt,
    tool: { name: "agent-receipt", version: installedVersion() },
    input: { file: o.inputFile, sha256: createHash("sha256").update(o.inputRaw).digest("hex") },
    subject: o.subject,
    provenance: o.provenance ?? null, // 자가보고 기록(모델/프롬프트/입력/커밋/테스트) — 판단 아님
    results: o.results,
    summary: o.summary,
    verdict: o.verdict,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, contentHash };
}

export function writeVerificationReceipt(outPath: string, o: VReceiptInput): string {
  const receipt = buildVerificationReceipt(o);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n");
  return receipt.contentHash as string;
}
