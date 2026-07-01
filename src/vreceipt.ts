import { createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { SCHEMA_VERSION } from "./evidencekernel.js";
import { installedVersion } from "./version.js";
import * as g from "./git.js";

// ── Verification Receipt (증적 체계·L5) ──
// 정직: 이 영수증이 뜻하는 것은 "이 버전의 검증기가 이 입력에 대해 이런 결과를 냈다"의 *기록(증적)*이지,
//   모델이 그 프롬프트를 실제 썼는지·commit이 그 실행에 연결되는지·provenance 가 참인지의 *증명*이 아니다.
// provenance 는 신뢰도로 계층화한다: verified(우리가 계산/git 로 대조) vs reported(자가보고·미증명).

export interface VReceiptInput {
  surface: string; // "research" | "council"
  inputFile: string;
  inputRaw: string; // 입력 원문(해시 대상)
  subject: string; // query / question
  provenance: unknown; // tierProvenance() 산출({verified, reported}) 또는 null
  results: unknown[];
  summary: Record<string, number>;
  verdict: "pass" | "fail";
  verifiedAt: string; // 호출부가 타임스탬프 주입
}

// provenance 계층화(git/fs IO — surface 가 호출). verified=우리가 실제 확인 / reported=자가보고 라벨.
export function tierProvenance(reported: unknown): { verified: Record<string, unknown>; reported: unknown } {
  const verified: Record<string, unknown> = {};
  if (reported && typeof reported === "object" && !Array.isArray(reported)) {
    const p = reported as Record<string, unknown>;
    // commit: git 으로 존재 확인 가능(계산검증). git 저장소 아니면 null(미확인).
    if (typeof p.commit === "string") {
      verified.commitExists = g.isGitRepo() ? g.commitExists(p.commit) : null;
    }
    // inputFiles: 우리가 실제 해시(계산검증). 못 읽으면 sha256:null.
    if (Array.isArray(p.inputFiles)) {
      verified.inputFiles = p.inputFiles
        .filter((x): x is string => typeof x === "string")
        .map((path) => {
          const fp = isAbsolute(path) ? path : join(process.cwd(), path);
          try {
            return { path, sha256: createHash("sha256").update(readFileSync(fp, "utf8")).digest("hex") };
          } catch {
            return { path, sha256: null };
          }
        });
    }
  }
  return { verified, reported: reported ?? null }; // reported = 자가보고(model/prompt/author/tests) — 미증명
}

// 봉인 본문 + 결정론 receiptId + self contentHash(순수: 같은 입력·verifiedAt·provenance → 같은 hash).
export function buildVerificationReceipt(o: VReceiptInput): Record<string, unknown> {
  const version = installedVersion();
  const inputSha256 = createHash("sha256").update(o.inputRaw).digest("hex");
  // receiptId: 타임스탬프 제외 → 같은 입력·같은 검증기 버전·같은 verdict 면 어디서든 같은 ID(크로스시스템 대조키).
  const receiptId = createHash("sha256").update(SCHEMA_VERSION + inputSha256 + version + o.verdict).digest("hex");
  const body: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    kind: "verification-receipt",
    receiptId,
    surface: o.surface,
    verifiedAt: o.verifiedAt,
    tool: { name: "agent-receipt", version },
    input: { file: o.inputFile, sha256: inputSha256 },
    subject: o.subject,
    provenance: o.provenance ?? { verified: {}, reported: null },
    results: o.results,
    summary: o.summary,
    verdict: o.verdict,
    means: "이 버전의 검증기가 이 입력에 대해 낸 결과의 기록(증적)이다. provenance.reported 는 자가보고이며, 모델·프롬프트 사용이나 실행 연결의 증명이 아니다.",
  };
  // contentHash: 전체(verifiedAt 포함) 봉인 — tamper-evident. (receiptId 는 타임스탬프 제외 대조키.)
  const contentHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, contentHash };
}

export function writeVerificationReceipt(outPath: string, o: VReceiptInput): { receiptId: string; contentHash: string } {
  const receipt = buildVerificationReceipt(o);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n");
  return { receiptId: receipt.receiptId as string, contentHash: receipt.contentHash as string };
}
