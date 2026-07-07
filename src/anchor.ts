import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { sign as edSign } from "node:crypto";
import { writeFileAtomic } from "./lock.js";
import { isAbsolute, join, basename } from "node:path";
import type { Receipt } from "./receipt.js";
import { buildAiWorkStatement } from "./attest.js";
import { approvalsCountFor, listReceipts, rekorAnchorPath, type RekorAnchor } from "./receiptStore.js";
import { ensureSigningKey, publicKeyFingerprint, publicKeyRelPath } from "./keys.js";

// ── Stage 1 (6차 council): 제3자 앵커 — in-toto Statement → DSSE 봉투 + ed25519 서명 → Rekor 투명성 로그.
// 한 명령(anchor --upload): 최신 영수증 자동 + 키 자동생성 + 서명 + Rekor 등록(node fetch·외부 도구 0).
// 원칙: npm 의존성 0(node crypto/fetch + 순수 PAE) · 정직 라벨(Rekor=시간·존재 봉인, keyless 신원은 아님) · 값 미노출(Statement만).

export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json"; // P2 백로그: predicate --sign 이 재사용(같은 payloadType — Statement 의 predicateType 이 종류를 구분)
const REKOR_URL = "https://rekor.sigstore.dev";

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

/** 순수함수: DSSE 봉투 → Rekor `dsse:0.0.1` 제안 엔트리 바디(실제 Rekor 201 응답으로 검증된 스키마). */
export function buildRekorDsseEntry(envelope: DsseEnvelope, publicPem: string): {
  apiVersion: string;
  kind: string;
  spec: { proposedContent: { envelope: string; verifiers: string[] } };
} {
  return {
    apiVersion: "0.0.1",
    kind: "dsse",
    spec: { proposedContent: { envelope: JSON.stringify(envelope), verifiers: [Buffer.from(publicPem).toString("base64")] } },
  };
}

/** 순수함수: Rekor 등록 결과(uuid, logIndex) → 영수증 옆에 남길 앵커 sidecar. share-proof 가 verifyUrl 을 검증 버튼으로 임베드. */
export function buildRekorAnchor(uuid: string, logIndex: number | null): RekorAnchor {
  return {
    uuid,
    logIndex,
    verifyUrl: `https://search.sigstore.dev/?uuid=${uuid}`,
    apiUrl: `${REKOR_URL}/api/v1/log/entries/${uuid}`,
  };
}

/** Rekor 공개 로그에 DSSE 봉투 등록(외부 publish). 201=신규/409=기존. {uuid, logIndex} 반환. */
async function uploadToRekor(envelope: DsseEnvelope, publicPem: string): Promise<{ uuid: string; logIndex: number | null }> {
  const res = await fetch(`${REKOR_URL}/api/v1/log/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRekorDsseEntry(envelope, publicPem)),
  });
  const txt = await res.text();
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`Rekor HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  const got = extractRekorUuid(txt, res.status);
  if (!got) throw new Error(`Rekor ${res.status}: 응답에서 UUID 추출 실패 — ${txt.slice(0, 200)}`);
  return got;
}

/**
 * 순수: Rekor 응답 바디 → {uuid, logIndex} 또는 null. 13차 council(#6) + 3R 하드닝.
 * 201=엔트리맵(키=UUID·logIndex). 409=이미 등록(바디 메시지에 UUID). 3R: 바디 전체 hex 스캔 폴백은 **409 한정** +
 * hex 길이 **40+**(실제 Rekor UUID=64) 로 제한 → 201 비표준/HTML 본문의 CSRF·logID·nonce 잡 hex 를 가짜 UUID 로 오인하지 않음.
 * 어느 경로도 못 맞히면 null(=가짜 증거 안 만듦).
 */
export function extractRekorUuid(txt: string, status?: number): { uuid: string; logIndex: number | null } | null {
  let obj: Record<string, { logIndex?: number }> = {};
  try {
    obj = JSON.parse(txt) as Record<string, { logIndex?: number }>;
  } catch {
    /* 비-JSON 바디 → 아래 409 메시지 정규식으로 */
  }
  const key = (obj && typeof obj === "object" ? Object.keys(obj)[0] : "") ?? "";
  if (/^[0-9a-f]{40,}$/i.test(key)) return { uuid: key, logIndex: obj[key]?.logIndex ?? null }; // 201 엔트리맵 키=UUID(실제 64hex)
  if (status === 409) {
    const m = txt.match(/[0-9a-f]{40,}/i); // 409 already-exists 메시지의 실제 UUID(409 한정·짧은 토큰 오인 방지)
    if (m) return { uuid: m[0], logIndex: null };
  }
  return null;
}

interface Prepared {
  envelope: DsseEnvelope;
  publicPem: string;
  bundleRel: string;
  receiptPath: string;
}

function resolveReceiptPath(receiptArg: string | undefined, cwd: string): string {
  if (receiptArg) {
    const p = isAbsolute(receiptArg) ? receiptArg : join(cwd, receiptArg);
    if (!existsSync(p)) {
      console.error(`anchor: receipt 파일 없음: ${receiptArg}`);
      process.exit(2);
    }
    return p;
  }
  const latest = listReceipts(cwd).find((e) => e.name.endsWith(".json"));
  if (!latest) {
    console.error("anchor: 저장된 receipt 없음 — 먼저 'agent-receipt done' 을 실행하거나 --receipt <경로> 를 지정하세요.");
    process.exit(2);
  }
  return latest.abs;
}

/** 영수증 로드(없으면 최신) → Stage0 Statement → DSSE 서명(키 자동생성) → 번들 저장. 오류는 process.exit(2). */
function prepareAnchor(receiptArg: string | undefined, cwd: string): Prepared {
  const rpath = resolveReceiptPath(receiptArg, cwd);
  let r: Receipt | null;
  try {
    r = JSON.parse(readFileSync(rpath, "utf8")) as Receipt;
  } catch {
    r = null;
  }
  if (!r || typeof r.contentHash !== "string") {
    console.error("anchor: json receipt 가 필요합니다(파싱 실패 또는 contentHash 없음).");
    process.exit(2);
  }
  let signing: { key: ReturnType<typeof ensureSigningKey>["key"]; publicPem: string };
  try {
    signing = ensureSigningKey(cwd); // 3R: 손상 private.pem 이면 raw 크래시 대신 깔끔한 exit 2(sign/verify 와 일관)
  } catch (e) {
    console.error(`anchor: ${(e as Error).message}`);
    process.exit(2);
  }
  const { key, publicPem } = signing;
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
  const bundleRel = outPath.startsWith(cwd + "/") ? outPath.slice(cwd.length + 1) : outPath;
  return { envelope, publicPem, bundleRel, receiptPath: rpath };
}

/** cwd 기준 상대경로(표시용). cwd 밖이면 절대경로 그대로. */
function relTo(cwd: string, p: string): string {
  return p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
}

/**
 * `agent-receipt anchor [--receipt <path>]` — 오프라인 prepare: DSSE 번들 생성 + 등록 방법 출력.
 * 실제 등록은 `--upload`(우리 도구) 또는 rekor-cli. exit 0 / 2.
 */
export function runAnchor(receiptArg: string | undefined, cwd: string = process.cwd()): never {
  const { bundleRel } = prepareAnchor(receiptArg, cwd);
  console.log(`anchor: DSSE 번들 준비됨 → ${bundleRel}`);
  console.log("");
  console.log("  ⚠️ 아직 Rekor 미등록 — 등록해야 제3자(시간·존재) 봉인이 됩니다.");
  console.log("  가장 쉬운 등록(외부 도구 불필요):");
  console.log("    agent-receipt anchor --upload");
  console.log("");
  console.log("  또는 rekor-cli 로:");
  console.log(`    rekor-cli upload --type dsse --artifact ${bundleRel} --public-key ${publicKeyRelPath()} --pki-format x509`);
  console.log("");
  console.log("  정직: Rekor 는 '시간·존재'를 제3자로 봉인하지만, 자기관리 ed25519 키라 keyless(신원) 증명은 아닙니다.");
  process.exit(0);
}

/**
 * `agent-receipt anchor --upload [--receipt <path>]` — 한 명령: 최신 영수증 + 키 자동 + 서명 + Rekor 등록.
 * 외부 도구 0(node fetch). main() 이 sync 라 async 업로드는 내부에서 처리하고 끝나면 process.exit.
 */
export function runAnchorUpload(receiptArg: string | undefined, cwd: string = process.cwd()): void {
  const { envelope, publicPem, bundleRel, receiptPath } = prepareAnchor(receiptArg, cwd);
  console.log(`anchor: DSSE 서명 완료 → ${bundleRel}`);
  console.log("  Rekor 공개 로그에 등록 중…");
  void (async () => {
    try {
      const { uuid, logIndex } = await uploadToRekor(envelope, publicPem);
      const anchor = buildRekorAnchor(uuid, logIndex);
      // 등록 성공을 먼저 보고(아래 sidecar 쓰기가 실패해도 등록 사실은 가림 없이).
      console.log("");
      console.log("✅ Rekor 등록 완료 — 이제 제3자(시간·존재)가 봉인했습니다.");
      console.log(`   logIndex : ${anchor.logIndex ?? "?"}`);
      console.log(`   검증 링크: ${anchor.verifyUrl}`);
      console.log(`   API      : ${anchor.apiUrl}`);
      // Stage 1b: 등록 결과를 영수증 옆 sidecar 로 기록 → share-proof 가 검증 링크를 자동 임베드. 실패해도 등록 자체는 유효.
      const sidecar = rekorAnchorPath(receiptPath);
      try {
        writeFileAtomic(sidecar, JSON.stringify(anchor, null, 2) + "\n"); // 3R: 원자쓰기 — 재등록 중 중단돼도 기존 유효 앵커 안 잘림
        console.log(`   앵커 기록 → ${relTo(cwd, sidecar)} (share-proof 가 이 검증 링크를 자동으로 영수증에 박습니다)`);
      } catch (e) {
        console.error(`   ⚠️ 앵커 sidecar 기록 실패(${relTo(cwd, sidecar)}): ${(e as Error).message} — 등록은 성공, share-proof 자동 임베드만 누락.`);
      }
      console.log("");
      console.log("   이 링크를 클라이언트에게 보내세요 — 나를 안 믿어도 공개 로그로 직접 확인합니다.");
      console.log("   (정직: 시간·존재 봉인이지 keyless 신원 증명은 아님.)");
      process.exit(0);
    } catch (e) {
      console.error("");
      console.error(`✗ Rekor 등록 실패: ${(e as Error).message}`);
      console.error(`  번들은 저장돼 있습니다(${bundleRel}). 네트워크 확인 후 재시도하세요.`);
      process.exit(1);
    }
  })();
}
