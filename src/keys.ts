import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, basename, relative } from "node:path";

// 키 저장 위치(고정). private.pem 은 절대 commit 하면 안 됨 — keys/ 는 verify 의 tool-output 제외 대상.
const KEYS_REL = join(".agent-guard", "keys");
const PRIV_REL = join(KEYS_REL, "private.pem");
const PUB_REL = join(KEYS_REL, "public.pem");

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}
function rel(p: string, cwd: string): string {
  const r = relative(cwd, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r;
}

/** `agent-receipt keys init` — ed25519 키쌍 생성(PEM). 이미 있으면 덮어쓰지 않음(exit 1). */
export function runKeysInit(cwd: string = process.cwd()): never {
  const privAbs = join(cwd, PRIV_REL);
  const pubAbs = join(cwd, PUB_REL);
  if (existsSync(privAbs) || existsSync(pubAbs)) {
    console.error(`이미 키가 있습니다 (${KEYS_REL}) — 덮어쓰지 않습니다. 새로 만들려면 먼저 제거하세요.`);
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(join(cwd, KEYS_REL), { recursive: true });
  writeFileSync(privAbs, privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
  writeFileSync(pubAbs, publicKey.export({ type: "spki", format: "pem" }) as string);
  console.log(`키 생성됨 (ed25519):\n  - ${PRIV_REL}\n  - ${PUB_REL}`);
  console.log("");
  console.log("⚠️  private.pem 은 절대 git 에 commit 하지 마세요.");
  console.log(`   .gitignore 에 직접 추가하세요(자동 수정 안 함):  ${KEYS_REL}/`);
  console.log("");
  process.exit(0);
}

/** `agent-receipt sign --receipt <path>` — receipt 파일 내용을 ed25519 로 서명, sidecar <receipt>.sig.json 저장. */
export function runSign(receiptArg: string | undefined, cwd: string = process.cwd()): never {
  if (!receiptArg) {
    console.error("sign: --receipt <path> 가 필요합니다.");
    process.exit(2);
  }
  const rpath = abs(receiptArg, cwd);
  if (!existsSync(rpath)) {
    console.error(`sign: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const privAbs = join(cwd, PRIV_REL);
  if (!existsSync(privAbs)) {
    console.error(`sign: private key 없음 (${PRIV_REL}) — 'agent-receipt keys init' 를 먼저 실행하세요.`);
    process.exit(2);
  }
  let key;
  try {
    key = createPrivateKey(readFileSync(privAbs));
  } catch {
    console.error("sign: private key 파싱 실패 (PEM 형식 확인).");
    process.exit(2);
  }
  const content = readFileSync(rpath);
  const signature = edSign(null, content, key).toString("base64");
  const sidecar = rpath + ".sig.json";
  const payload = { algo: "ed25519", target: basename(rpath), signature, signedAt: new Date().toISOString() };
  writeFileSync(sidecar, JSON.stringify(payload, null, 2) + "\n");
  console.log(`서명 저장: ${rel(sidecar, cwd)} (ed25519)`);
  console.log("  검증:  agent-receipt verify-signature --receipt " + receiptArg);
  process.exit(0);
}

/**
 * `agent-receipt verify-signature --receipt <path>` — public.pem 으로 sidecar 서명 검증.
 *  PASS=0 / FAIL=1 / 파일·키·파싱 문제=2.
 */
export function runVerifySignature(receiptArg: string | undefined, cwd: string = process.cwd()): never {
  if (!receiptArg) {
    console.error("verify-signature: --receipt <path> 가 필요합니다.");
    process.exit(2);
  }
  const rpath = abs(receiptArg, cwd);
  if (!existsSync(rpath)) {
    console.error(`verify-signature: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const sidecar = rpath + ".sig.json";
  if (!existsSync(sidecar)) {
    console.error(`verify-signature: 서명 파일 없음 (${rel(sidecar, cwd)}) — 'agent-receipt sign' 을 먼저 실행하세요.`);
    process.exit(2);
  }
  const pubAbs = join(cwd, PUB_REL);
  if (!existsSync(pubAbs)) {
    console.error(`verify-signature: public key 없음 (${PUB_REL}).`);
    process.exit(2);
  }
  let sig: { signature?: unknown };
  try {
    sig = JSON.parse(readFileSync(sidecar, "utf8"));
  } catch {
    console.error("verify-signature: 서명 파일 파싱 실패.");
    process.exit(2);
  }
  if (typeof sig.signature !== "string") {
    console.error("verify-signature: 서명 파일에 signature 필드가 없습니다.");
    process.exit(2);
  }
  let pub;
  try {
    pub = createPublicKey(readFileSync(pubAbs));
  } catch {
    console.error("verify-signature: public key 파싱 실패.");
    process.exit(2);
  }
  const ok = edVerify(null, readFileSync(rpath), pub, Buffer.from(sig.signature, "base64"));
  console.log("");
  console.log(ok ? `서명 검증: PASS ✅  (${basename(rpath)} = 서명 당시 내용)` : `서명 검증: FAIL ❌  (${basename(rpath)} 가 변조되었거나 키 불일치)`);
  console.log("");
  process.exit(ok ? 0 : 1);
}
