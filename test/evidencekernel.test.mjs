// Evidence Kernel(공유 코어) — 인용 대조 순수 커널. research·council 이 재사용하는 그 코어.
// `node test/evidencekernel.test.mjs`.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { normalizeForCitation, verifyCitationInText, citationStatus, parseNumbersFromText, recompute, numberStatus, canonicalizeDate, dateStatus, linkStatus, evaluateClaim, hashStatus, signatureStatus, CHECK_KINDS, claimSchema, SCHEMA_VERSION, commitStatus, fileChangedStatus, diffContainsStatus, schemaStatus, schemaMismatches, versionStatus, semverSatisfies, parseSemver, fileStatus, receiptStatus, artifactStatus } from "../dist/evidencekernel.js";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const kp = generateKeyPairSync("ed25519");
const pubPem = kp.publicKey.export({ format: "pem", type: "spki" }).toString();
const sigOf = (m) => edSign(null, Buffer.from(m, "utf8"), kp.privateKey).toString("base64");

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

check("normalize: 공백 collapse+trim", () => assert.equal(normalizeForCitation("  a   b\n c "), "a b c"));
check("verify: 정확한 부분문자열", () => assert.equal(verifyCitationInText("sky is blue", "the sky is blue today"), true));
check("verify: 공백차이 정규화 일치", () => assert.equal(verifyCitationInText("sky   is\nblue", "sky is blue"), true));
check("verify: 날조는 false", () => assert.equal(verifyCitationInText("sky is green", "sky is blue"), false));
check("verify: 빈 인용 false", () => assert.equal(verifyCitationInText("  ", "x"), false));

check("status verified", () => assert.equal(citationStatus("hello world", "say hello world now"), "verified"));
check("status not-found", () => assert.equal(citationStatus("ghost", "real only"), "not-found"));
check("status no-source: source null", () => assert.equal(citationStatus("x", null), "no-source"));
check("status no-source: 빈 인용", () => assert.equal(citationStatus("", "some source"), "no-source"));

// ── 수치 커널 ──
check("parseNumbers: 콤마·소수·음수", () => assert.deepEqual(parseNumbersFromText("value 1,234.5 and -3 done"), [1234.5, -3]));
check("recompute sum", () => assert.equal(recompute("sum", [1, 2, 3]), 6));
check("recompute mean", () => assert.equal(recompute("mean", [2, 4]), 3));
check("recompute percent", () => assert.equal(recompute("percent", [1, 4]), 25));
check("recompute ratio 0분모 → null", () => assert.equal(recompute("ratio", [1, 0]), null));
check("number 모드A verified: 출처에 실재", () => assert.equal(numberStatus(42, { source: "the answer is 42 today" }), "verified"));
check("number 모드A mismatch: 출처에 없음", () => assert.equal(numberStatus(99, { source: "the answer is 42" }), "mismatch"));
check("number 모드B verified: 재계산 일치", () => assert.equal(numberStatus(6, { op: "sum", operands: [1, 2, 3] }), "verified"));
check("number 모드B mismatch: 재계산 불일치", () => assert.equal(numberStatus(7, { op: "sum", operands: [1, 2, 3] }), "mismatch"));
check("number no-basis: stated null", () => assert.equal(numberStatus(null, { source: "42" }), "no-basis"));
check("number no-basis: 근거 없음", () => assert.equal(numberStatus(5, {}), "no-basis"));
check("number eps 허용오차", () => assert.equal(numberStatus(3.14, { op: "sum", operands: [3.14], eps: 0.001 }), "verified"));

// ── 날짜 커널 ──
check("canonicalizeDate: ISO", () => assert.equal(canonicalizeDate("2026-1-5"), "2026-01-05"));
check("canonicalizeDate: Mon DD, YYYY", () => assert.equal(canonicalizeDate("Jan 5, 2026"), "2026-01-05"));
check("canonicalizeDate: DD Mon YYYY", () => assert.equal(canonicalizeDate("5 January 2026"), "2026-01-05"));
check("canonicalizeDate: 파싱불가 → null", () => assert.equal(canonicalizeDate("last tuesday"), null));
check("date verified: 다른 형식 같은 날 일치", () => assert.equal(dateStatus("2026-01-05", "published on Jan 5, 2026 here"), "verified"));
check("date mismatch: 다른 날", () => assert.equal(dateStatus("2026-01-05", "published on 2026-02-01"), "mismatch"));
check("date no-basis: 파싱불가 stated", () => assert.equal(dateStatus("someday", "2026-01-05"), "no-basis"));

// ── 링크 커널 ──
check("link valid: https", () => assert.equal(linkStatus("https://example.com/x"), "valid"));
check("link valid: http", () => assert.equal(linkStatus("http://a.b"), "valid"));
check("link invalid: 스킴 아님", () => assert.equal(linkStatus("ftp://x"), "invalid"));
check("link invalid: 형식 깨짐", () => assert.equal(linkStatus("not a url"), "invalid"));

// ── evaluateClaim (표준 포맷 단일 의미론) ──
check("eval: 인용 verified → verified", () => {
  const e = evaluateClaim({ quotedText: "sky is blue" }, "the sky is blue");
  assert.equal(e.verified, true); assert.equal(e.failed, false); assert.equal(e.citation, "verified");
});
check("eval: 수치 mismatch → failed", () => {
  const e = evaluateClaim({ statedValue: 99, sourceText: undefined, op: "sum", operands: [1, 2] }, null);
  assert.equal(e.failed, true); assert.equal(e.number, "mismatch");
});
check("eval: 날짜 verified", () => {
  const e = evaluateClaim({ statedDate: "2026-01-05" }, "on Jan 5, 2026");
  assert.equal(e.date, "verified"); assert.equal(e.verified, true);
});
check("eval: link invalid → failed", () => {
  const e = evaluateClaim({ link: "not a url" }, null);
  assert.equal(e.link, "invalid"); assert.equal(e.failed, true);
});
check("eval: link valid 는 advisory(verified 아님)", () => {
  const e = evaluateClaim({ link: "https://x.y" }, null);
  assert.equal(e.link, "valid"); assert.equal(e.verified, false); assert.equal(e.failed, false);
});
check("eval: 복합 — 인용+수치 둘 다 verified", () => {
  const e = evaluateClaim({ quotedText: "42 items", statedValue: 42, sourceText: "we found 42 items" }, "we found 42 items");
  assert.equal(e.citation, "verified"); assert.equal(e.number, "verified"); assert.equal(e.verified, true);
});

// ── 해시 커널 ──
check("hash verified: content 해시 일치", () => assert.equal(hashStatus(sha("hello"), "hello"), "verified"));
check("hash mismatch: 다른 content", () => assert.equal(hashStatus(sha("hello"), "world"), "mismatch"));
check("hash no-basis: content null", () => assert.equal(hashStatus(sha("x"), null), "no-basis"));
check("hash 대소문자 무관", () => assert.equal(hashStatus(sha("hello").toUpperCase(), "hello"), "verified"));
check("eval hash verified(레지스트리 경유)", () => {
  const e = evaluateClaim({ statedHash: sha("data"), content: "data" }, null);
  assert.equal(e.hash, "verified"); assert.equal(e.verified, true);
});
check("eval hash mismatch → failed", () => {
  const e = evaluateClaim({ statedHash: sha("data"), content: "other" }, null);
  assert.equal(e.hash, "mismatch"); assert.equal(e.failed, true);
});

// ── 서명 커널(ed25519) ──
check("signature verified: 유효 서명", () => assert.equal(signatureStatus("hello", sigOf("hello"), pubPem), "verified"));
check("signature invalid: content 변조", () => assert.equal(signatureStatus("tampered", sigOf("hello"), pubPem), "invalid"));
check("signature no-basis: 키 없음", () => assert.equal(signatureStatus("hello", sigOf("hello"), null), "no-basis"));
check("signature no-basis: 서명 없음", () => assert.equal(signatureStatus("hello", null, pubPem), "no-basis"));
check("eval signature verified(레지스트리 경유)", () => {
  const e = evaluateClaim({ content: "hi", signature: sigOf("hi"), publicKey: pubPem }, null);
  assert.equal(e.signature, "verified"); assert.equal(e.verified, true);
});
check("eval signature invalid → failed", () => {
  const e = evaluateClaim({ content: "hi", signature: sigOf("bye"), publicKey: pubPem }, null);
  assert.equal(e.signature, "invalid"); assert.equal(e.failed, true);
});

// ── evidence(expected/actual·증명) ──
check("evidence: number mismatch → expected/actual(재계산)", () => {
  const e = evaluateClaim({ statedValue: 10, op: "sum", operands: [1, 2] }, null);
  assert.equal(e.number, "mismatch");
  assert.equal(e.evidence.number.expected, "10");
  assert.ok(e.evidence.number.actual.includes("3"));
});
check("evidence: 통과 시 비어있음", () => {
  const e = evaluateClaim({ quotedText: "sky is blue" }, "the sky is blue");
  assert.equal(Object.keys(e.evidence).length, 0);
});

// ── Evidence Specification ──
check("CHECK_KINDS: 레지스트리에 hash·signature 확장 반영", () => assert.ok(CHECK_KINDS.includes("hash") && CHECK_KINDS.includes("signature") && CHECK_KINDS.includes("citation")));
check("claimSchema: schemaVersion + 구조 + checkKinds", () => {
  const s = claimSchema();
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
  assert.ok(s.properties && s.properties.quotedText && s.properties.statedHash);
  assert.ok(Array.isArray(s.checkKinds) && s.checkKinds.includes("hash"));
});

// ── Phase4: git 사실 검증(commit/fileChanged/diffContains) — 커널은 순수, surface 사전조회 사실만 받음 ──
check("commitStatus: 존재→verified·부재→mismatch·조회불가(null)→no-basis·주장없음→no-basis", () => {
  assert.equal(commitStatus("abc123", true), "verified");
  assert.equal(commitStatus("abc123", false), "mismatch");
  assert.equal(commitStatus("abc123", null), "no-basis");
  assert.equal(commitStatus(null, true), "no-basis");
});
check("fileChangedStatus: 변경목록에 있으면 verified·없으면 not-found·목록없음(null)→no-basis", () => {
  assert.equal(fileChangedStatus("src/foo.ts", "src/foo.ts\nsrc/bar.ts"), "verified");
  assert.equal(fileChangedStatus("src/baz.ts", "src/foo.ts\nsrc/bar.ts"), "not-found");
  assert.equal(fileChangedStatus("src/foo.ts", null), "no-basis");
  assert.equal(fileChangedStatus(null, "src/foo.ts"), "no-basis");
});
check("diffContainsStatus: diff 텍스트에 있으면 verified·없으면 not-found", () => {
  assert.equal(diffContainsStatus("+  return null;", "@@ -1,2 +1,3 @@\n+  return null;\n"), "verified");
  assert.equal(diffContainsStatus("+  return 42;", "@@ -1,2 +1,3 @@\n+  return null;\n"), "not-found");
  assert.equal(diffContainsStatus("x", null), "no-basis");
});

// ── Phase4: 스키마 검증(JSON Schema 서브셋 · 순수) ──
check("schemaStatus: 기본 type 일치 → verified", () => assert.equal(schemaStatus("hi", { type: "string" }), "verified"));
check("schemaStatus: type 불일치 → mismatch", () => assert.equal(schemaStatus(42, { type: "string" }), "mismatch"));
check("schemaStatus: object required+properties 중첩 검증", () => {
  const schema = { type: "object", required: ["name", "age"], properties: { name: { type: "string" }, age: { type: "number" } } };
  assert.equal(schemaStatus({ name: "a", age: 1 }, schema), "verified");
  assert.equal(schemaStatus({ name: "a" }, schema), "mismatch"); // age 없음(required)
  assert.equal(schemaStatus({ name: "a", age: "1" }, schema), "mismatch"); // age 타입 틀림
});
check("schemaStatus: enum 위반 → mismatch", () => assert.equal(schemaStatus("red", { enum: ["a", "b"] }), "mismatch"));
check("schemaStatus: array items 중첩 검증", () => {
  const schema = { type: "array", items: { type: "number" } };
  assert.equal(schemaStatus([1, 2, 3], schema), "verified");
  assert.equal(schemaStatus([1, "x", 3], schema), "mismatch");
});
check("schemaStatus: data/schema 없음 → no-basis", () => {
  assert.equal(schemaStatus(undefined, { type: "string" }), "no-basis");
  assert.equal(schemaStatus("x", null), "no-basis");
});
check("schemaMismatches: path+reason 구조로 구체적 위치 보고(재계산 가능·캐시 아님)", () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "number" } } };
  const m = schemaMismatches({ a: "not-a-number" }, schema);
  assert.equal(m.length, 1);
  assert.equal(m[0].path, "$.a");
  assert.ok(m[0].reason.includes("type"));
});

// ── Phase4: 버전/의존성 검증(순수) ──
check("versionStatus: 정확일치 verified·range접두(^~) 벗기고 비교·불일치 mismatch", () => {
  assert.equal(versionStatus("zod", "3.23.8", { zod: "3.23.8" }), "verified");
  assert.equal(versionStatus("zod", "3.23.8", { zod: "^3.23.8" }), "verified"); // 접두 벗김
  assert.equal(versionStatus("zod", "^3.23.8", { zod: "3.23.8" }), "verified"); // 양쪽 다 벗김
  assert.equal(versionStatus("zod", "3.0.0", { zod: "3.23.8" }), "mismatch");
});
check("versionStatus: 맵에 없거나 맵 자체 없음 → no-basis(거짓 mismatch 아님)", () => {
  assert.equal(versionStatus("nope", "1.0.0", { zod: "3.23.8" }), "no-basis");
  assert.equal(versionStatus("zod", "3.23.8", null), "no-basis");
  assert.equal(versionStatus(null, "3.23.8", { zod: "3.23.8" }), "no-basis");
});

// ── Phase4: evaluateClaim 통합 — 5종 전부 결과에 반영 + CHECK_KINDS/claimSchema 확장 ──
check("evaluateClaim: commit/fileChanged/diffContains/schema/version 전부 dispatch 됨", () => {
  const e = evaluateClaim({
    statedCommit: "deadbeef", commitExists: true,
    statedChangedFile: "a.ts", changedFiles: "a.ts\nb.ts",
    statedDiffText: "+x", diffText: "+x\n-y",
    schemaData: { n: 1 }, schemaDef: { type: "object", required: ["n"] },
    statedPackage: "zod", statedPackageVersion: "3.23.8", dependencyMap: { zod: "3.23.8" },
  }, null);
  assert.equal(e.commit, "verified");
  assert.equal(e.fileChanged, "verified");
  assert.equal(e.diffContains, "verified");
  assert.equal(e.schema, "verified");
  assert.equal(e.version, "verified");
  assert.equal(e.failed, false);
  assert.equal(e.verified, true);
});
check("evaluateClaim: 5종 중 하나라도 mismatch/not-found 면 failed=true + evidence 생성", () => {
  const e = evaluateClaim({ statedCommit: "deadbeef", commitExists: false }, null);
  assert.equal(e.commit, "mismatch");
  assert.equal(e.failed, true);
  assert.ok(e.evidence.commit && e.evidence.commit.expected === "deadbeef");
});
check("evaluateClaim: schema mismatch 도 evidence 에 구체적 위치 포함", () => {
  const e = evaluateClaim({ schemaData: { n: "x" }, schemaDef: { type: "object", properties: { n: { type: "number" } } } }, null);
  assert.equal(e.schema, "mismatch");
  assert.ok(e.evidence.schema && e.evidence.schema.actual.includes("$.n"));
});
check("CHECK_KINDS: Phase4 5종(commit/fileChanged/diffContains/schema/version) 전부 포함", () => {
  for (const k of ["commit", "fileChanged", "diffContains", "schema", "version"]) assert.ok(CHECK_KINDS.includes(k), `누락: ${k}`);
});
check("claimSchema: Phase4 신규 property 노출(statedCommit·schemaDef·statedPackage 등)", () => {
  const s = claimSchema();
  assert.ok(s.properties.statedCommit && s.properties.schemaDef && s.properties.statedPackage && s.properties.statedPackageVersion);
});

// ── Phase5: semver 진짜 범위판정(승격) — 기존 4결과 불변 + 범위충족 신규 ──
check("semver: 기존 동작 보존 — 정확일치·접두동일·불일치·no-basis 그대로", () => {
  assert.equal(versionStatus("zod", "3.23.8", { zod: "3.23.8" }), "verified");
  assert.equal(versionStatus("zod", "3.23.8", { zod: "^3.23.8" }), "verified");
  assert.equal(versionStatus("zod", "^3.23.8", { zod: "3.23.8" }), "verified");
  assert.equal(versionStatus("zod", "3.0.0", { zod: "3.23.8" }), "mismatch");
});
check("semver: ^ 범위 진짜 충족 — ^3.23.8 에 3.24.0 은 verified(승격 목적)·4.0.0 은 mismatch", () => {
  assert.equal(versionStatus("zod", "3.24.0", { zod: "^3.23.8" }), "verified");
  assert.equal(versionStatus("zod", "4.0.0", { zod: "^3.23.8" }), "mismatch");
});
check("semver: ~ 는 minor 고정·비교자 >=/</<=/> 작동", () => {
  assert.equal(versionStatus("a", "1.2.9", { a: "~1.2.3" }), "verified");
  assert.equal(versionStatus("a", "1.3.0", { a: "~1.2.3" }), "mismatch");
  assert.equal(versionStatus("a", "2.0.0", { a: ">=1.5" }), "verified");
  assert.equal(versionStatus("a", "1.4.9", { a: ">=1.5" }), "mismatch");
  assert.equal(versionStatus("a", "0.9.0", { a: "<1.0.0" }), "verified");
});
check("semver: ^0.y.z 는 npm 규약(최좌측 비0 고정)", () => {
  assert.equal(versionStatus("a", "0.2.9", { a: "^0.2.3" }), "verified");
  assert.equal(versionStatus("a", "0.3.0", { a: "^0.2.3" }), "mismatch");
});
check("semver: prerelease·복합범위·와일드카드 → no-basis(거짓판정 금지)", () => {
  assert.equal(versionStatus("a", "1.0.0", { a: "1.0.0-beta" }), "no-basis");
  assert.equal(versionStatus("a", "1.0.0-rc.1", { a: "^1.0.0" }), "no-basis");
  assert.equal(versionStatus("a", "1.5.0", { a: ">=1.0.0 <2.0.0" }), "no-basis");
  assert.equal(versionStatus("a", "1.5.0", { a: "1.x" }), "no-basis");
});
check("parseSemver/semverSatisfies 단독: 부분버전 0채움", () => {
  assert.deepEqual(parseSemver("3"), [3, 0, 0]);
  assert.equal(semverSatisfies("3.5.0", "^3"), true);
});

// ── Phase5: file 체크(스펙 Planned 이행) ──
check("fileStatus: 존재→verified·부재→not-found·조회불가/주장없음→no-basis", () => {
  assert.equal(fileStatus("a.ts", true), "verified");
  assert.equal(fileStatus("a.ts", false), "not-found");
  assert.equal(fileStatus("a.ts", null), "no-basis");
  assert.equal(fileStatus(null, true), "no-basis");
});

// ── Phase5: receipt 체크(인용 영수증 실재+무결) ──
const okFacts = { found: true, isVerificationReceipt: true, contentHashOk: true, receiptIdOk: true, actualReceiptId: "abcdef1234567890" };
check("receiptStatus: 실재+무결+id 접두 일치 → verified", () =>
  assert.equal(receiptStatus("abcdef12", okFacts), "verified"));
check("receiptStatus: 인용 파일 부재 → mismatch(인용 정확성은 인용자 책임·DA① evidence 로 완화)", () =>
  assert.equal(receiptStatus("abcdef12", { ...okFacts, found: false }), "mismatch"));
check("receiptStatus: id 접두 불일치 → mismatch", () =>
  assert.equal(receiptStatus("ffffffff", okFacts), "mismatch"));
check("receiptStatus: 봉인 재계산 실패(변조) → mismatch", () =>
  assert.equal(receiptStatus("abcdef12", { ...okFacts, contentHashOk: false }), "mismatch"));
check("receiptStatus: Work Receipt 등 미지원 종류 → no-basis(v1 정직 범위)", () =>
  assert.equal(receiptStatus("abcdef12", { ...okFacts, isVerificationReceipt: false }), "no-basis"));
check("receiptStatus: 접두 8자 미만/facts 없음 → no-basis", () => {
  assert.equal(receiptStatus("abc", okFacts), "no-basis");
  assert.equal(receiptStatus("abcdef12", null), "no-basis");
});
check("evaluateClaim: file+receipt dispatch + 실패 evidence 생성", () => {
  const e = evaluateClaim({ statedFile: "x.ts", fileExists: false, statedReceiptId: "abcdef12", receiptFacts: { ...okFacts, found: false } }, null);
  assert.equal(e.file, "not-found");
  assert.equal(e.receipt, "mismatch");
  assert.equal(e.failed, true);
  assert.ok(e.evidence.file && e.evidence.receipt);
});
check("CHECK_KINDS: Phase5 2종(file/receipt)+Phase6 artifact 포함 — 총 14종", () => {
  assert.ok(CHECK_KINDS.includes("file") && CHECK_KINDS.includes("receipt") && CHECK_KINDS.includes("artifact"));
  assert.equal(CHECK_KINDS.length, 14);
});

// ── Phase6: artifact 형태 검증(제약 ≥1 필수·크기 경계·sha) ──
const artOk = { exists: true, sizeBytes: 1000, sha256: null };
check("artifactStatus: 크기 경계 충족 → verified·미달/초과 → mismatch", () => {
  assert.equal(artifactStatus("a.bin", { minBytes: 500 }, artOk), "verified");
  assert.equal(artifactStatus("a.bin", { minBytes: 2000 }, artOk), "mismatch");
  assert.equal(artifactStatus("a.bin", { maxBytes: 500 }, artOk), "mismatch");
  assert.equal(artifactStatus("a.bin", { minBytes: 500, maxBytes: 1500 }, artOk), "verified");
});
check("artifactStatus: 부재 → not-found·제약 없음 → no-basis(file 체크와 중복 방지)", () => {
  assert.equal(artifactStatus("a.bin", { minBytes: 1 }, { exists: false, sizeBytes: null, sha256: null }), "not-found");
  assert.equal(artifactStatus("a.bin", {}, artOk), "no-basis");
  assert.equal(artifactStatus(null, { minBytes: 1 }, artOk), "no-basis");
  assert.equal(artifactStatus("a.bin", { minBytes: 1 }, null), "no-basis");
});
check("artifactStatus: sha 제약 일치/불일치·계산불가는 no-basis(거짓 mismatch 금지)", () => {
  assert.equal(artifactStatus("a.bin", { sha256: "AABB" }, { exists: true, sizeBytes: 5, sha256: "aabb" }), "verified");
  assert.equal(artifactStatus("a.bin", { sha256: "ffff" }, { exists: true, sizeBytes: 5, sha256: "aabb" }), "mismatch");
  assert.equal(artifactStatus("a.bin", { sha256: "ffff" }, { exists: true, sizeBytes: 5, sha256: null }), "no-basis");
});
check("evaluateClaim: artifact dispatch + 실패 evidence(제약·실측 병기)", () => {
  const e = evaluateClaim({ statedArtifact: "dist/out.js", artifactMinBytes: 100, artifactFacts: { exists: true, sizeBytes: 3, sha256: null } }, null);
  assert.equal(e.artifact, "mismatch");
  assert.equal(e.failed, true);
  assert.ok(e.evidence.artifact && e.evidence.artifact.expected.includes("min 100B") && e.evidence.artifact.actual.includes("3B"));
});

if (fail.length) { console.error(`evidencekernel: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`evidencekernel: ${pass} pass ✅`);
