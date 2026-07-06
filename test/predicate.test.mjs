// R4 in-toto predicate(claim-verification/v1) 테스트 — Statement 형태·subject digest·스키마·결정론.
import assert from "node:assert";
import { buildClaimVerificationStatement, claimVerificationPredicateSchema, CLAIM_VERIFICATION_PREDICATE_TYPE } from "../dist/predicate.js";

const receipt = {
  kind: "verification-receipt",
  receiptId: "abc123receiptid",
  contentHash: "deadbeef".repeat(8), // 64 hex
  surface: "bench",
  verdict: "pass",
  subject: "R1 시드셋",
  summary: { total: 12, tp: 5, fp: 1 },
  provenance: { verified: {}, reported: null },
  tool: { name: "agent-receipt", version: "0.15.3" },
};

const s = buildClaimVerificationStatement(receipt);
assert.equal(s._type, "https://in-toto.io/Statement/v1");
assert.equal(s.predicateType, CLAIM_VERIFICATION_PREDICATE_TYPE);
assert.equal(s.predicateType, "https://promptia-labs.dev/agent-receipt/claim-verification/v1");
assert.equal(s.subject.length, 1);
assert.equal(s.subject[0].name, "R1 시드셋");
assert.equal(s.subject[0].digest.sha256, receipt.contentHash, "subject digest = 영수증 contentHash");
assert.equal(s.predicate.tool, "agent-receipt");
assert.equal(s.predicate.toolVersion, "0.15.3");
assert.equal(s.predicate.surface, "bench");
assert.equal(s.predicate.verdict, "pass");
assert.equal(s.predicate.receiptId, "abc123receiptid");
assert.deepEqual(s.predicate.summary, { total: 12, tp: 5, fp: 1 });
assert.ok(typeof s.predicate.disclosure === "string" && s.predicate.disclosure.length > 0);

// sha256: 접두 제거
const s2 = buildClaimVerificationStatement({ ...receipt, contentHash: "sha256:" + "cafe".repeat(16) });
assert.equal(s2.subject[0].digest.sha256, "cafe".repeat(16), "sha256: 접두 제거");

// 결정론: 같은 입력 → 같은 Statement(바이트 동일)
assert.equal(JSON.stringify(buildClaimVerificationStatement(receipt)), JSON.stringify(s));

// subject 없으면 기본 이름
const s3 = buildClaimVerificationStatement({ kind: "verification-receipt", contentHash: "aa".repeat(32) });
assert.equal(s3.subject[0].name, "verification-receipt");
assert.equal(s3.predicate.surface, null);

// predicate 스키마
const schema = claimVerificationPredicateSchema();
assert.equal(schema.predicateType, CLAIM_VERIFICATION_PREDICATE_TYPE);
assert.deepEqual(schema.required, ["tool", "surface", "verdict"]);
assert.deepEqual(schema.properties.surface.enum, ["research", "council", "bench"]);

console.log("predicate.test: OK — claim-verification/v1 Statement + 스키마 (subject digest=영수증 contentHash·결정론)");
