// 적합성 테스트벡터 생성기 (Agent Receipt Format · seal contentHash).
// 목적: 제3자 구현이 자기 receiptHash 를 (receipt, expectedContentHash) 쌍으로 바이트 검증할 수 있게.
//       동시에 우리 봉인의 회귀 가드(receiptHash 가 바뀌면 벡터가 깨짐).
// 재생성: `node test/vectors/generate.mjs` (dist 빌드 후). 결정론적(봉인 입력에 시간/환경 없음).
// 검증: `node test/receipt-vectors.test.mjs`.
import { receiptHash } from "../../dist/receipt.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

// 고정 timestamp 는 봉인에서 제외되지만 realistic 한 receipt 를 위해 넣는다(해시 불변).
const TS = "2026-01-01T00:00:00.000Z";
const base = () => ({
  schemaVersion: "1.1",
  ok: true,
  contractId: "vec-contract",
  title: null,
  branch: { current: "main", expected: "main", ok: true },
  headHash: "0123456789abcdef0123456789abcdef01234567",
  timestamp: TS,
  touched: [],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  violations: [],
  session: null,
  checks: [],
  magnitude: { filesChanged: 0, added: 0, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  policy: null,
  environment: { agentReceiptVersion: "vec", nodeVersion: "vec", os: "vec" },
  disclosure: "test vector",
});

// 봉인이 덮는 모든 갈래를 대표: 최소·실패·변경·판정·행위·내용해시·임계경로.
const cases = [
  { name: "minimal-pass", make: () => base() },
  {
    name: "fail-with-violations",
    make: () => ({ ...base(), ok: false, violations: ["out-of-scope: secret.txt", "denied: .env"] }),
  },
  {
    name: "with-changes-and-checks",
    make: () => ({
      ...base(),
      touched: ["src/b.ts", "src/a.ts"], // 정렬 전(봉인이 정렬)
      staged: ["src/a.ts"],
      magnitude: { filesChanged: 2, added: 40, deleted: 3, newFiles: 0 },
      checks: [
        { name: "tsc", exitCode: 0, requiredExit: 0, ok: true },
        { name: "test", exitCode: 1, requiredExit: 0, ok: false },
      ],
    }),
  },
  {
    name: "with-verdict-and-snapshot",
    make: () => ({
      ...base(),
      verdict: { verdict: "PASS", reasons: ["all checks passed"], mark: "PASS" },
      contractSnapshot: { kind: "implementation", contractHash: "sha256:deadbeef", allowedGlobs: 2, deniedGlobs: [".env"] },
    }),
  },
  {
    name: "with-actions-and-reconciliation",
    make: () => ({
      ...base(),
      actions: [
        { flag: "WRITE", path: "src/x.ts" },
        { flag: "READ", path: "src/y.ts" },
      ],
      reconciliation: { matched: 1, residuals: [], gitVisible: 1 },
    }),
  },
  {
    name: "with-content-hashes",
    make: () => ({
      ...base(),
      touched: ["src/a.ts"],
      contentHashes: [{ path: "src/a.ts", sha256: "sha256:cafebabe", bytes: 128 }],
    }),
  },
  {
    name: "critical-path-touched",
    make: () => ({
      ...base(),
      touched: ["billing/charge.ts"],
      criticalPaths: [{ glob: "billing/**", touched: ["billing/charge.ts"] }],
    }),
  },
];

const vectors = cases.map((c) => {
  const receipt = c.make();
  const hash = receiptHash(receipt);
  receipt.contentHash = hash; // realistic receipt.json
  return { name: c.name, expectedContentHash: hash, receipt };
});

writeFileSync(join(dir, "vectors.json"), JSON.stringify(vectors, null, 2) + "\n");
console.log(`vectors: generated ${vectors.length} → test/vectors/vectors.json`);
