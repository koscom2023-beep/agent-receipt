import { createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as g from "./git.js";
import { receiptHash, type Receipt } from "./receipt.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

function readJson(p: string): any | null {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * `agent-receipt replay --pack <dir>` (별칭 verify-pack) — 저장된 audit-pack 을 현재 repo 상태와 대조해 재검증.
 *  - manifest/receipt 존재·파싱
 *  - receipt.contentHash 무변조(저장 필드로 재계산 == 기록값)
 *  - headHash 가 현재 repo 에 존재
 *  - (있으면) signature sidecar 를 receipt.json 바이트로 검증(advisory)
 * 한계: 당시 외부 DB/OS 명령은 재현 불가 — git 으로 확인 가능한 것만 재검증.
 * exit: PASS 0 / mismatch 1 / 파일없음·파싱실패·커밋없음 2.
 */
export function runReplay(packArg: string | undefined, cwd: string = process.cwd()): never {
  if (!packArg) {
    console.error("replay: --pack <dir> 가 필요합니다.");
    process.exit(2);
  }
  const dir = isAbsolute(packArg) ? packArg : join(cwd, packArg);
  const manifestPath = join(dir, "manifest.json");
  const receiptPath = join(dir, "receipt.json");
  if (!existsSync(manifestPath) || !existsSync(receiptPath)) {
    console.error(`replay: pack 이 불완전합니다 (manifest.json / receipt.json 필요): ${packArg}`);
    process.exit(2);
  }
  const manifest = readJson(manifestPath);
  const receipt = readJson(receiptPath) as Receipt | null;
  if (!manifest || !receipt) {
    console.error("replay: manifest/receipt JSON 파싱 실패.");
    process.exit(2);
  }

  console.log("");
  console.log(line);
  console.log(`agent-receipt replay: ${receipt.contractId ?? "?"}  (audit-pack 재검증 — git 기준)`);
  console.log(line);

  let mismatch = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    if (!ok) mismatch++;
    console.log(`  ${ok ? "✓" : "✗"} ${label}: ${detail}`);
  };

  // 1) manifest ↔ receipt contentHash 합치
  const manHash = typeof manifest.contentHash === "string" ? manifest.contentHash : null;
  check(
    "manifest/receipt 합치",
    manHash !== null && manHash === receipt.contentHash,
    manHash === receipt.contentHash ? "contentHash 동일" : `manifest ${manHash} ≠ receipt ${receipt.contentHash}`,
  );

  // 2) contentHash 무변조: 저장된 필드로 재계산 == 기록값
  let recomputed = "(계산 불가)";
  try {
    recomputed = receiptHash(receipt);
  } catch {
    /* 필드 부족 → 아래 mismatch */
  }
  check(
    "receipt 무변조(contentHash 재계산)",
    recomputed === receipt.contentHash,
    recomputed === receipt.contentHash ? "재계산 일치 (tamper-evident: 변조 없음)" : `재계산 ${recomputed} ≠ 기록 ${receipt.contentHash}`,
  );

  // 3) headHash 가 현재 repo 에 존재
  const head = typeof receipt.headHash === "string" ? receipt.headHash : "";
  const headOk = g.isGitRepo() && g.commitExists(head);
  check("headHash 존재", headOk, headOk ? `${head} 현재 repo 에 있음` : `${head || "(없음)"} — 현재 repo 에서 못 찾음(다른 clone/미페치?)`);

  // 4) (advisory) signature sidecar 검증 — 게이트 아님(재렌더/redact 시 바이트가 달라질 수 있음)
  const sigPath = join(dir, "signature.sig.json");
  const pubPath = join(cwd, ".agent-guard", "keys", "public.pem");
  if (existsSync(sigPath)) {
    const sig = readJson(sigPath);
    if (sig && typeof sig.signature === "string" && existsSync(pubPath)) {
      try {
        const pub = createPublicKey(readFileSync(pubPath));
        const ok = edVerify(null, readFileSync(receiptPath), pub, Buffer.from(sig.signature, "base64"));
        console.log(`  ${ok ? "✓" : "·"} signature(advisory): ${ok ? "receipt.json 바이트와 일치" : "불일치 — 원본 receipt 로 verify-signature 권장"}`);
      } catch {
        console.log("  · signature(advisory): public key 파싱 실패 — verify-signature 로 별도 확인");
      }
    } else {
      console.log("  · signature(advisory): sidecar 존재(공개키 없음/형식 불명) — `verify-signature` 로 별도 확인");
    }
  }

  console.log(line);
  if (mismatch === 0) {
    console.log("결과: PASS ✅ — 이 pack 은 기록된 git 상태와 합치하며 변조 흔적 없음.");
  } else {
    console.log(`결과: mismatch ${mismatch}건 ❌ — 위 항목을 확인하세요.`);
  }
  console.log("한계: 당시 외부 DB write·OS 명령·외부 서비스는 재현/검증 불가 — git 으로 확인 가능한 것만 재검증합니다.");
  console.log("  " + LIMIT_NOTE);
  console.log(line);
  console.log("");
  process.exit(mismatch === 0 ? 0 : 1);
}
