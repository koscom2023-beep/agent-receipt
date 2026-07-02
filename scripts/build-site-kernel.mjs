#!/usr/bin/env node
// site/kernel.js 생성 — dist/evidencekernel.js 를 브라우저용으로 *기계 변환*(손 재구현 금지=두 진실원 금지).
// 변환 내용 단 두 가지: ① node:crypto import 1줄 제거 ② throw shim 주입(crypto 필요 종류는 CLI 몫).
// 결과 동등성은 test/site-kernel.test.mjs 가 npm test 마다 기계 검증(순수 종류 verdict 일치·crypto 종류 명시 throw).
// ⚠️ site/kernel.js 는 사이트 내부용 산출물 — SDK 공개 계약 아님(계약은 패키지 배럴/docs/SDK.md).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "dist", "evidencekernel.js"), "utf8");

const IMPORT_LINE = 'import { createHash, verify as cryptoVerify, createPublicKey } from "node:crypto";';
if (!src.includes(IMPORT_LINE)) {
  console.error("build-site-kernel: 예상한 crypto import 줄이 없음 — dist 구조가 바뀜. 변환 중단(침묵 생성 금지).");
  process.exit(2);
}
const SHIM = `// [generated] browser shim — crypto 종류(hash·signature·fingerprint·receipt)는 브라우저 플레이그라운드 범위 밖(CLI 에서 실행).
const __noCrypto = (what) => { throw new Error(what + " 는 브라우저 플레이그라운드에서 지원하지 않습니다 — CLI(agent-receipt)에서 실행하세요"); };
const createHash = () => __noCrypto("hash/fingerprint");
const cryptoVerify = () => __noCrypto("signature");
const createPublicKey = () => __noCrypto("signature");
`;
const out =
  "// ⚠️ 자동 생성 파일 — 편집 금지. scripts/build-site-kernel.mjs 가 dist/evidencekernel.js 에서 생성.\n" +
  SHIM +
  src.replace(IMPORT_LINE, "");
writeFileSync(join(root, "site", "kernel.js"), out);
console.log(`site/kernel.js 생성 (${(out.length / 1024) | 0}KB · dist 기계변환·재구현 0)`);
