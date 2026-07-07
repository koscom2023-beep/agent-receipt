// 백로그 D8 — gen-claim LLM 분해 브릿지 e2e(LLM 호출 0 — 분해는 LLM·판정은 결정론).
// 수용기준(council): 프롬프트=결정론(2회 동일 바이트)+스키마 SSOT 임베드 · from-llm=allowlist 정규화(발명 필드 드랍·
//   statement 필수·미검증 라벨 파일 박제) · 정규화 산출이 research verify 로 실제 판정됨(날조=격추 실증).
// `node test/genclaim-llm.test.mjs`.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { claimFieldAllowlist } from "../dist/genclaim.js";
import { claimSchema } from "../dist/evidencekernel.js";

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

const dir = join(process.env.TMPDIR || "/tmp", `ar-genllm-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const run = (args) => spawnSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8" });

// allowlist = 스키마 SSOT(하드코딩 드리프트 방지)
check("allowlist 는 claimSchema properties 에서 도출", () => {
  const props = Object.keys(claimSchema().properties);
  assert.deepEqual(claimFieldAllowlist(), [...props].sort());
  assert.ok(claimFieldAllowlist().includes("statement") && claimFieldAllowlist().includes("quotedText"));
});

// --llm-prompt: 결정론 + 핵심 규칙 + 스키마 임베드
const p1 = run(["gen-claim", "--llm-prompt"]);
const p2 = run(["gen-claim", "--llm-prompt"]);
check("--llm-prompt 결정론(2회 동일 바이트) + verbatim 규칙 + 스키마", () => {
  assert.equal(p1.status, 0);
  assert.equal(p1.stdout, p2.stdout, "비결정 출력");
  assert.ok(p1.stdout.includes("verbatim copy"), "인용 발명 금지 규칙");
  assert.ok(p1.stdout.includes("agent-receipt Evidence Claim"), "스키마 임베드(SSOT)");
  assert.ok(p1.stdout.includes("판정은 결정론"), "분해=LLM·판정=결정론 명시");
});

// --from-llm: allowlist 정규화 + 미검증 라벨
writeFileSync(join(dir, "src.txt"), "the real quote lives here\n");
writeFileSync(
  join(dir, "resp.json"),
  JSON.stringify({
    query: "테스트",
    claims: [
      { statement: "진짜 인용", quotedText: "the real quote lives here", sourceFile: "src.txt", inventedField: "x", confidence: 0.9 },
      { statement: "날조 인용", quotedText: "this quote was fabricated by the llm", sourceFile: "src.txt" },
      { noStatement: true },
    ],
  }),
);
const f = run(["gen-claim", "--from-llm", "resp.json", "--out", "claims.json"]);
check("--from-llm 정규화 — 발명 필드 드랍·statement 없는 claim 드랍·보고", () => {
  assert.equal(f.status, 0, f.stdout + f.stderr);
  assert.ok(f.stdout.includes("claim 2건 유지") && f.stdout.includes("드랍 1건"), f.stdout);
  assert.ok(f.stdout.includes("confidence") && f.stdout.includes("inventedField"), "드랍 필드 명시 보고");
  const doc = JSON.parse(readFileSync(join(dir, "claims.json"), "utf8"));
  assert.ok(doc.note.includes("UNVERIFIED"), "미검증 라벨 파일 박제");
  assert.equal(doc.claims.length, 2);
  assert.ok(!("inventedField" in doc.claims[0]) && !("confidence" in doc.claims[0]), "allowlist 밖 제거");
  assert.equal(doc.claims[0].quotedText, "the real quote lives here", "값은 보존(변조 없음)");
});

// 체인 실증: 정규화 산출 → research verify 가 결정론 판정(진짜=verified·날조=격추 exit 1)
const rv = run(["research", "verify", "--file", "claims.json"]);
check("판정은 결정론 — 진짜 인용 verified·날조 인용 FAIL(exit 1·DA-4 구조 실증)", () => {
  assert.equal(rv.status, 1, `날조가 통과함? exit=${rv.status}\n${rv.stdout}`);
  assert.ok(rv.stdout.includes("verified 1"), "진짜 인용은 verified");
  assert.ok(rv.stdout.includes("FAIL 1"), "날조 인용은 기계 격추");
});

// 오류 경로
check("--from-llm 깨진 JSON = exit 2", () => {
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(run(["gen-claim", "--from-llm", "bad.json"]).status, 2);
});
check("--from-llm 사용할 claim 0건 = exit 2", () => {
  writeFileSync(join(dir, "empty.json"), JSON.stringify({ query: "q", claims: [{ noStatement: 1 }] }));
  assert.equal(run(["gen-claim", "--from-llm", "empty.json"]).status, 2);
});

rmSync(dir, { recursive: true, force: true });
if (fail.length) {
  console.error(`genclaim-llm.test: FAIL ${fail.length}\n - ` + fail.join("\n - "));
  process.exit(1);
}
console.log(`genclaim-llm.test: OK (${pass}) — 프롬프트 결정론·allowlist SSOT·미검증 라벨·날조 기계격추 체인 실증`);
