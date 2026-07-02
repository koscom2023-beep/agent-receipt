import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
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
    // commitExistsInRepo: 그 commit 이 저장소에 *존재*하는가만(계산검증). git 저장소 아니면 null.
    //   ⚠ 존재 확인일 뿐 — "이 영수증이 그 commit 으로 생성됐다"는 뜻이 절대 아니다(그 연결은 여전히 자가보고).
    if (typeof p.commit === "string") {
      verified.commitExistsInRepo = g.isGitRepo() ? g.commitExists(p.commit) : null;
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
  mkdirSync(dirname(outPath), { recursive: true }); // --out vr/r1.json 처럼 새 폴더 경로도 그대로 동작(퀵스타트 첫 명령 크래시 방지)
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n");
  return { receiptId: receipt.receiptId as string, contentHash: receipt.contentHash as string };
}

// ── Verification Receipt 재검증(replay·L5 재현성) ──
// 저장된 영수증의 무결성을 시간축으로 재검증: contentHash/receiptId 재계산(변조탐지) +
//   (옵션) 입력 파일 재해시(input.sha256 대조=드리프트) + commit 재조회(링크로트). 순수 판정.
export function replayVerificationReceipt(
  receipt: Record<string, unknown>,
  opts: { inputContent?: string | null } = {},
): { contentHashOk: boolean; receiptIdOk: boolean; inputMatch: boolean | null; commitRecheck: boolean | null } {
  const stated = receipt.contentHash;
  const body: Record<string, unknown> = { ...receipt };
  delete body.contentHash;
  const contentHashOk = typeof stated === "string" && createHash("sha256").update(JSON.stringify(body)).digest("hex") === stated;

  const input = receipt.input as { sha256?: unknown; file?: unknown } | undefined;
  const tool = receipt.tool as { version?: unknown } | undefined;
  const recomputedId = createHash("sha256")
    .update(String(receipt.schemaVersion) + String(input?.sha256) + String(tool?.version) + String(receipt.verdict))
    .digest("hex");
  const receiptIdOk = receipt.receiptId === recomputedId;

  let inputMatch: boolean | null = null;
  if (typeof opts.inputContent === "string" && typeof input?.sha256 === "string") {
    inputMatch = createHash("sha256").update(opts.inputContent).digest("hex") === input.sha256;
  }
  let commitRecheck: boolean | null = null;
  const prov = receipt.provenance as { reported?: { commit?: unknown } } | undefined;
  const commit = prov?.reported?.commit;
  if (typeof commit === "string" && g.isGitRepo()) commitRecheck = g.commitExists(commit);

  return { contentHashOk, receiptIdOk, inputMatch, commitRecheck };
}

// CLI: `agent-receipt replay --receipt <path>`
export function runReplayReceipt(pathArg: string | undefined): never {
  const line = "─".repeat(56);
  if (!pathArg) {
    console.error("replay --receipt <path> 가 필요합니다 (Verification Receipt JSON).");
    process.exit(2);
  }
  const p = isAbsolute(pathArg) ? pathArg : join(process.cwd(), pathArg);
  let receipt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
    receipt = parsed as Record<string, unknown>;
  } catch {
    console.error(`replay: 영수증을 못 읽음/파싱 실패: ${pathArg}`);
    process.exit(2);
  }
  if (receipt.kind !== "verification-receipt") {
    console.error("replay --receipt: verification-receipt 아님(audit-pack 은 replay --pack).");
    process.exit(2);
  }
  let inputContent: string | null = null;
  const input = receipt.input as { file?: unknown } | undefined;
  if (typeof input?.file === "string") {
    const fp = isAbsolute(input.file) ? input.file : join(process.cwd(), input.file);
    try {
      inputContent = readFileSync(fp, "utf8");
    } catch {
      inputContent = null;
    }
  }
  const r = replayVerificationReceipt(receipt, { inputContent });
  console.log("");
  console.log(line);
  console.log(`Verification Receipt 재검증: ${pathArg}  (receiptId ${String(receipt.receiptId).slice(0, 12)}…)`);
  console.log(line);
  console.log(`  contentHash 재계산: ${r.contentHashOk ? "✓ 무변조" : "✗ TAMPERED(변조)"}`);
  console.log(`  receiptId 재계산  : ${r.receiptIdOk ? "✓ 정합" : "✗ 불일치"}`);
  console.log(`  입력 재해시       : ${r.inputMatch === null ? "· (입력 파일 없음·건너뜀)" : r.inputMatch ? "✓ 입력 불변" : "✗ 입력 변경(드리프트)"}`);
  console.log(`  commit 재조회     : ${r.commitRecheck === null ? "· (git 없음/commit 없음)" : r.commitRecheck ? "✓ 여전히 존재" : "✗ 소멸(링크로트)"}`);
  const fail = !r.contentHashOk || !r.receiptIdOk;
  console.log(line);
  console.log(fail ? "  ❌ 재검증 실패 — 영수증 변조/불일치" : "  ✅ 영수증 무결(contentHash·receiptId 정합)");
  console.log("  보증: 영수증 자체의 무결성·재현성이지 원 검증대상의 진위 아님.");
  console.log(line);
  console.log("");
  process.exit(fail ? 1 : 0);
}
