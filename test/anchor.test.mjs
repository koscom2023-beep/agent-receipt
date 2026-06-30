// anchor(Stage 1) — DSSE PAE 정답값·봉투 형태·ed25519 서명→검증 왕복·결정론·변조탐지.
// `node test/anchor.test.mjs`. 네트워크(Rekor 등록)는 owner 수동이라 여기선 미검(순수부분만 잠금).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { dssePae, buildDsseEnvelope, buildRekorDsseEntry } from "../dist/anchor.js";

let pass = 0;
const fail = [];
const check = (n, fn) => {
  try {
    fn();
    pass++;
  } catch (e) {
    fail.push(`${n}: ${e.message}`);
  }
};

const PT = "application/vnd.in-toto+json";

check("DSSE PAE v1 정답값(스펙 — len 은 바이트)", () => {
  const pae = dssePae(PT, Buffer.from("hello"));
  assert.equal(pae.toString("utf8"), "DSSEv1 28 application/vnd.in-toto+json 5 hello");
});
check("PAE 길이 = 바이트 수", () => {
  assert.equal(dssePae("t", Buffer.from("ab")).toString("utf8"), "DSSEv1 1 t 2 ab");
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

check("DSSE 봉투 형태 + payload base64 + keyid", () => {
  const obj = { _type: "https://in-toto.io/Statement/v1" };
  const payload = Buffer.from(JSON.stringify(obj));
  const env = buildDsseEnvelope(payload, PT, (pae) => ({ sig: edSign(null, pae, privateKey).toString("base64"), keyid: "sha256:abc" }));
  assert.equal(env.payloadType, PT);
  assert.equal(Buffer.from(env.payload, "base64").toString(), JSON.stringify(obj));
  assert.equal(env.signatures.length, 1);
  assert.equal(env.signatures[0].keyid, "sha256:abc");
});
check("서명→검증 왕복: 검증자가 PAE 재구성 후 ed25519 검증 성공", () => {
  const payload = Buffer.from("payload-bytes");
  const env = buildDsseEnvelope(payload, PT, (pae) => ({ sig: edSign(null, pae, privateKey).toString("base64") }));
  const recomputedPae = dssePae(env.payloadType, Buffer.from(env.payload, "base64"));
  const ok = edVerify(null, recomputedPae, publicKey, Buffer.from(env.signatures[0].sig, "base64"));
  assert.ok(ok, "DSSE 서명이 재구성한 PAE 에 대해 검증 실패");
});
check("ed25519 결정론 — 같은 입력·키 → 같은 서명", () => {
  const sigOf = () =>
    buildDsseEnvelope(Buffer.from("det"), "t", (pae) => ({ sig: edSign(null, pae, privateKey).toString("base64") })).signatures[0].sig;
  assert.equal(sigOf(), sigOf());
});
check("변조 탐지 — payload 바뀌면 서명 검증 실패", () => {
  const env = buildDsseEnvelope(Buffer.from("orig"), "t", (pae) => ({ sig: edSign(null, pae, privateKey).toString("base64") }));
  const tamperedPae = dssePae("t", Buffer.from("HACKED"));
  const ok = edVerify(null, tamperedPae, publicKey, Buffer.from(env.signatures[0].sig, "base64"));
  assert.ok(!ok, "변조됐는데 검증 통과");
});

check("Rekor dsse 엔트리 바디 형태(실 Rekor 201로 검증된 스키마)", () => {
  const env = buildDsseEnvelope(Buffer.from("{}"), PT, () => ({ sig: "QQ==" }));
  const pem = "-----BEGIN PUBLIC KEY-----\nXYZ\n-----END PUBLIC KEY-----\n";
  const entry = buildRekorDsseEntry(env, pem);
  assert.equal(entry.kind, "dsse");
  assert.equal(entry.apiVersion, "0.0.1");
  assert.equal(typeof entry.spec.proposedContent.envelope, "string");
  assert.equal(JSON.parse(entry.spec.proposedContent.envelope).payloadType, PT);
  assert.equal(Buffer.from(entry.spec.proposedContent.verifiers[0], "base64").toString(), pem);
});

if (fail.length) {
  console.error(`anchor: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`anchor: ${pass} pass, 0 fail`);
