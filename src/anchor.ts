import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sign as edSign } from "node:crypto";
import { isAbsolute, join, basename } from "node:path";
import type { Receipt } from "./receipt.js";
import { buildAiWorkStatement } from "./attest.js";
import { approvalsCountFor } from "./receiptStore.js";
import { loadPrivateKey, publicKeyFingerprint, publicKeyRelPath } from "./keys.js";

// ── Stage 1 (6차 council): 제3자 앵커 토대 — in-toto Statement → DSSE 봉투 + 기존 ed25519 서명 → Rekor-ready 번들.
// 원칙: 새 의존성 0(node crypto + 순수 PAE) · 실제 Rekor 등록은 표준도구(cosign/rekor-cli)로 owner 수동(외부 publish)
//        · 정직 라벨(Rekor=시간·존재 제3자 봉인, keyless 신원은 아님 · 등록 전엔 미봉인) · 값 미노출(Statement만 — 경로/분류).

const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** DSSE PAE(Pre-Authentication Encoding) v1: "DSSEv1 SP len(type) SP type SP len(body) SP body"(바이트). 순수함수. */
export function dssePae(payloadType: string, payload: Buffer): Buffer {
  const ptLen = Buffer.byteLength(payloadType, "utf8");
  const head = Buffer.from(`DSSEv1 ${ptLen} ${payloadType} ${payload.length} `, "utf8");
  return Buffer.concat([head, payload]);
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string; // base64(payload)
  signatures: Array<{ sig: string; keyid?: string }>;
}

/** 순수함수: payload(Buffer) → DSSE 봉투. signer 는 PAE 바이트를 받아 base64 서명을 돌려준다(테스트 주입 가능). */
export function buildDsseEnvelope(
  payload: Buffer,
  payloadType: string,
  signer: (pae: Buffer) => { sig: string; keyid?: string },
): DsseEnvelope {
  const pae = dssePae(payloadType, payload);
  const { sig, keyid } = signer(pae);
  return {
    payloadType,
    payload: payload.toString("base64"),
    signatures: [keyid ? { sig, keyid } : { sig }],
  };
}

function readReceipt(p: string): Receipt | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Receipt;
  } catch {
    return null;
  }
}

/**
 * `agent-receipt anchor --receipt <path>` — Stage0 in-toto Statement 를 DSSE 로 서명해 Rekor-ready 번들 생성.
 * 기본=오프라인 prepare(번들 저장 + 등록 명령 출력). 실제 Rekor 등록은 표준도구로 owner 수동(외부 publish). exit 0 / 2.
 */
export function runAnchor(receiptArg: string | undefined, cwd: string = process.cwd()): never {
  if (!receiptArg) {
    console.error("anchor: --receipt <path> 가 필요합니다.");
    process.exit(2);
  }
  const rpath = isAbsolute(receiptArg) ? receiptArg : join(cwd, receiptArg);
  if (!existsSync(rpath)) {
    console.error(`anchor: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const r = readReceipt(rpath);
  if (!r || typeof r.contentHash !== "string") {
    console.error("anchor: json receipt 가 필요합니다(파싱 실패 또는 contentHash 없음).");
    process.exit(2);
  }
  const key = loadPrivateKey(cwd);
  if (!key) {
    console.error("anchor: private key 없음 — 'agent-receipt keys init' 를 먼저 실행하세요.");
    process.exit(2);
  }
  const keyid = publicKeyFingerprint(cwd) ?? undefined;

  const statement = buildAiWorkStatement(r, approvalsCountFor(rpath));
  const payload = Buffer.from(JSON.stringify(statement));
  const envelope = buildDsseEnvelope(payload, DSSE_PAYLOAD_TYPE, (pae) => ({
    sig: edSign(null, pae, key).toString("base64"),
    keyid,
  }));

  const outDir = join(cwd, ".agent-guard", "anchors");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, basename(rpath).replace(/\.json$/, "") + ".dsse.json");
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n");
  const outRel = outPath.startsWith(cwd + "/") ? outPath.slice(cwd.length + 1) : outPath;

  console.log(`anchor: DSSE 번들 준비됨 → ${outRel}`);
  console.log(`  서명: ed25519(${keyid ?? "local"}) over DSSE PAE · payloadType=${DSSE_PAYLOAD_TYPE}`);
  console.log("");
  console.log("  ⚠️ 아직 Rekor 미등록 — 등록해야 제3자(시간·존재) 봉인이 됩니다.");
  console.log("  Rekor 공개 로그에 등록(수동·외부 publish·해시/서명만 공개):");
  console.log(`    rekor-cli upload --type dsse --artifact ${outRel} --public-key ${publicKeyRelPath()} --pki-format x509`);
  console.log("    (rekor-cli 설치 필요 · ed25519 PEM 공개키라 --pki-format x509 필수)");
  console.log("");
  console.log("  정직: Rekor 는 '시간·존재'를 제3자로 봉인(issuer 백데이트·삭제 불가)하지만,");
  console.log("        자기관리 ed25519 키이므로 keyless(Fulcio/OIDC) 신원 비가역 증명은 아닙니다.");
  process.exit(0);
}
