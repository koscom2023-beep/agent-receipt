// 백로그 D7 — predicate --sign(검증영수증 오프라인 DSSE 서명) e2e.
// 수용기준(council): 기존 키 재사용(키 2벌 금지)·anchor 와 같은 payloadType·업로드 0·서명이 실제로 검증됨.
// `node test/predicate-sign.test.mjs`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dssePae, DSSE_PAYLOAD_TYPE } from "../dist/anchor.js";
import { CLAIM_VERIFICATION_PREDICATE_TYPE } from "../dist/predicate.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let pass = 0;
const fail = [];
const check = (name, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
};

const dir = join(process.env.TMPDIR || "/tmp", `ar-predsign-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });

// 실제 verification receipt 생성(합성 금지) — research verify --out (git 불필요·인라인 출처)
writeFileSync(
  join(dir, "claims.json"),
  JSON.stringify({ query: "t", claims: [{ statement: "합 5", statedNumbers: [5], recompute: { op: "sum", operands: [2, 3] } }] }),
);
const rv = run(["research", "verify", "--file", "claims.json", "--out", "vr.json"]);
check("사전조건: verification receipt 생성", () => assert.equal(rv.status, 0, rv.stdout + rv.stderr));

// --sign: 오프라인 DSSE 서명(기본 출력 경로)
const sg = run(["predicate", "--receipt", "vr.json", "--sign"]);
const envPath = join(dir, ".agent-guard", "anchors", "vr.vreceipt.dsse.json");
check("--sign exit 0 + 봉투 파일 생성 + 정직 고지", () => {
  assert.equal(sg.status, 0, sg.stdout + sg.stderr);
  assert.ok(existsSync(envPath), "vreceipt.dsse.json");
  assert.ok(sg.stdout.includes("신원 증명·Rekor 등록 아님"), "정직 고지(오프라인·자기키)");
});

const envelope = JSON.parse(readFileSync(envPath, "utf8"));
check("봉투 형식 — anchor 와 같은 payloadType·서명 1개·keyid", () => {
  assert.equal(envelope.payloadType, DSSE_PAYLOAD_TYPE, "payloadType 동일(발명 금지)");
  assert.equal(envelope.signatures.length, 1);
  assert.ok(envelope.signatures[0].sig.length > 0);
});
check("payload = claim-verification/v1 Statement · subject.digest = 영수증 contentHash", () => {
  const st = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
  assert.equal(st.predicateType, CLAIM_VERIFICATION_PREDICATE_TYPE);
  const vr = JSON.parse(readFileSync(join(dir, "vr.json"), "utf8"));
  assert.equal(st.subject[0].digest.sha256, vr.contentHash.replace(/^sha256:/, ""));
});
check("서명이 실제로 검증됨(ed25519 · PAE 위) — 기존 키 재사용", () => {
  const pubPem = readFileSync(join(dir, ".agent-guard", "keys", "public.pem"), "utf8"); // --sign 이 만든/재사용한 키
  const pub = createPublicKey(pubPem);
  const pae = dssePae(envelope.payloadType, Buffer.from(envelope.payload, "base64"));
  const ok = edVerify(null, pae, pub, Buffer.from(envelope.signatures[0].sig, "base64"));
  assert.equal(ok, true, "DSSE 서명 검증 실패");
});
check("두 번째 --sign 이 키를 재생성하지 않음(키 보존·과거 서명 유효 유지)", () => {
  const before = readFileSync(join(dir, ".agent-guard", "keys", "public.pem"), "utf8");
  const sg2 = run(["predicate", "--receipt", "vr.json", "--sign", "--out", "env2.json"]);
  assert.equal(sg2.status, 0, sg2.stderr);
  const after = readFileSync(join(dir, ".agent-guard", "keys", "public.pem"), "utf8");
  assert.equal(before, after, "키가 바뀜(재생성 금지 위반)");
});
check("--sign 없이는 기존 stdout 동작 불변", () => {
  const p = run(["predicate", "--receipt", "vr.json"]);
  assert.equal(p.status, 0);
  assert.ok(JSON.parse(p.stdout).predicateType === CLAIM_VERIFICATION_PREDICATE_TYPE);
});

rmSync(dir, { recursive: true, force: true });
if (fail.length) {
  console.error(`predicate-sign.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`predicate-sign.test: OK (${pass}) — 오프라인 DSSE·payloadType 동일·서명 실검증·키 보존·기존 동작 불변`);
