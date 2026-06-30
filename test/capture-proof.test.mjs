// 완전성 보증 iter1b — share-proof 에 git∖capture 차집합(훅 사각)·커버리지 caveat 노출.
// 잠금: capture 부재→섹션 없음(byte-safe·골든143) · 갭>0→섹션 노출 · 갭0→섹션 없음(byte-safe) · esc.
// `node test/capture-proof.test.mjs`.
import assert from "node:assert/strict";
import { toProofHtml } from "../dist/shareproof.js";

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

const base = {
  schemaVersion: "1.0",
  ok: true,
  contractId: "demo",
  title: null,
  branch: { current: "main", expected: null, ok: true },
  headHash: "abc1234",
  timestamp: "2026-01-01T00:00:00.000Z",
  touched: [],
  staged: [],
  untracked: [],
  outOfScope: [],
  deniedHits: [],
  violations: [],
  session: null,
  checks: [{ name: "build", exitCode: 0, requiredExit: 0, ok: true }],
  magnitude: { filesChanged: 1, added: 2, deleted: 0, newFiles: 0 },
  criticalPaths: [],
  policy: null,
  environment: {},
  disclosure: "x",
  contentHash: "sha256:deadbeef",
};

// 1) capture 부재(actions 키 없음) → 커버리지 섹션 없음(=골든143 바이트불변 경로)
check("capture 부재 → Capture coverage 섹션 없음", () => {
  const h = toProofHtml({ ...base, touched: ["a.ts"] }); // actions 미설정
  assert.ok(!h.includes("Capture coverage"), "capture 없는데 커버리지 섹션 누출(골든 회귀 위험)");
});

// 2) capture 있고 갭>0 → 섹션 노출(건수·미커버 경로·caveat)
check("capture+갭 → 차집합 섹션 노출", () => {
  const r = {
    ...base,
    touched: ["src/x.ts", "src/y.ts"],
    actions: [{ tool: "Write", op: "write", path: "src/x.ts", flag: "FILE_WRITE" }],
    actionsSummary: { total: 1, secretFilesRead: 0, externalCalls: 0, createdThenDeleted: 0, gitVisible: 1 },
  };
  const h = toProofHtml(r);
  assert.ok(h.includes("Capture coverage"), "커버리지 섹션 누락");
  assert.ok(h.includes("src/y.ts"), "미커버 경로 누락");
  assert.ok(!h.includes("src/x.ts</code></li>\n  <li><code>src/x.ts"), "커버된 경로가 갭으로 잘못 표시");
  assert.ok(h.includes("Captured surface"), "커버리지 caveat 누락");
  assert.ok(h.includes("not complete"), "정직 라벨(not complete) 누락");
});

// 3) capture 있고 갭0(actions 가 git 변경을 전부 커버) → 섹션 없음(byte-safe)
check("capture+갭0 → 섹션 없음", () => {
  const r = {
    ...base,
    touched: ["a.ts"],
    actions: [{ tool: "Write", op: "write", path: "a.ts", flag: "FILE_WRITE" }],
    actionsSummary: { total: 1, secretFilesRead: 0, externalCalls: 0, createdThenDeleted: 0, gitVisible: 1 },
  };
  const h = toProofHtml(r);
  assert.ok(!h.includes("Capture coverage"), "갭0인데 섹션 노출");
});

// 4) 미커버 경로도 HTML esc(injection 방어)
check("미커버 경로 esc", () => {
  const r = {
    ...base,
    touched: ['<script>x</script>.ts'],
    actions: [{ tool: "Read", op: "read", path: "other.ts", flag: "FILE_READ" }],
    actionsSummary: { total: 1, secretFilesRead: 0, externalCalls: 0, createdThenDeleted: 0, gitVisible: 0 },
  };
  const h = toProofHtml(r);
  assert.ok(!h.includes("<script>x</script>.ts"), "미커버 경로 미이스케이프(주입)");
  assert.ok(h.includes("&lt;script&gt;"), "esc 누락");
});

// 5) capture 부재 시 자동로드 0 유지(섹션 추가가 src= 들이지 않음)
check("커버리지 섹션도 자동로드(src=) 0", () => {
  const r = {
    ...base,
    touched: ["src/x.ts", "src/y.ts"],
    actions: [{ tool: "Write", op: "write", path: "src/x.ts", flag: "FILE_WRITE" }],
    actionsSummary: { total: 1, secretFilesRead: 0, externalCalls: 0, createdThenDeleted: 0, gitVisible: 1 },
  };
  assert.ok(!toProofHtml(r).includes("src="), "src= 존재(외부 자동로드 위험)");
});

if (fail.length) {
  console.error(`capture-proof: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`capture-proof: ${pass} pass, 0 fail`);
