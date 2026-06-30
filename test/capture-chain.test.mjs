// 완전성 보증(6차 council iter1) — capture 해시체인 + seq + degraded + 커버리지.
// 잠금: 변조/삭제/재정렬/중간누락 탐지 · 레거시 분리 · degraded 는 행위에서 제외(영수증 byte 안전) · 체인필드는 actions 에 누출 안 됨.
// `node test/capture-chain.test.mjs`.
import assert from "node:assert/strict";
import { captureEntryHash, verifyCaptureChain, aggregateActions, classifyEvent, COVERED_TOOLS } from "../dist/capture.js";

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

// appendCapture 와 동형으로 레코드 체인을 구성(테스트용).
function chain(recs, sessionId) {
  let prevHash;
  let seq = 0;
  return recs.map((r) => {
    seq += 1;
    const c = { ...r, seq };
    if (sessionId) c.sessionId = sessionId;
    if (prevHash) c.prevHash = prevHash;
    c.entryHash = captureEntryHash(c);
    prevHash = c.entryHash;
    return c;
  });
}
const base = [
  { ts: "2026-01-01T00:00:01.000Z", phase: "post", tool: "Read", op: "read", path: ".env" },
  { ts: "2026-01-01T00:00:02.000Z", phase: "post", tool: "Bash", op: "network", host: "api.example" },
  { ts: "2026-01-01T00:00:03.000Z", phase: "post", tool: "Write", op: "write", path: "src/a.ts" },
];

// ── 해시 순수함수 ──
check("captureEntryHash 결정론 + 필드 민감", () => {
  const r = { ...base[0], seq: 1 };
  assert.equal(captureEntryHash(r), captureEntryHash({ ...r }));
  assert.notEqual(captureEntryHash(r), captureEntryHash({ ...r, path: "other" }));
  assert.notEqual(captureEntryHash(r), captureEntryHash({ ...r, seq: 2 }));
  assert.ok(captureEntryHash(r).startsWith("sha256:"));
});

// ── 정상 체인 ──
check("정상 체인 → 문제 0·verified 전수", () => {
  const { problems, verified, legacy } = verifyCaptureChain(chain(base, "s1"));
  assert.equal(problems.length, 0, problems.join("|"));
  assert.equal(verified, 3);
  assert.equal(legacy, 0);
});

// ── 변조 ──
check("레코드 변조(entryHash 재계산 안 함) → 탐지", () => {
  const c = chain(base, "s1");
  c[1] = { ...c[1], path: "HACKED" }; // entryHash 그대로 → 불일치
  const { problems } = verifyCaptureChain(c);
  assert.ok(problems.some((p) => p.includes("entryHash 불일치")), problems.join("|"));
});

// ── 중간 삭제 ──
check("중간 레코드 삭제 → prevHash/seq 불연속 탐지", () => {
  const c = chain(base, "s1");
  const removed = [c[0], c[2]]; // 가운데 삭제
  const { problems } = verifyCaptureChain(removed);
  assert.ok(problems.length >= 1, "삭제 미탐지");
  assert.ok(problems.some((p) => p.includes("prevHash") || p.includes("seq")), problems.join("|"));
});

// ── 재정렬 ──
check("재정렬 → 탐지", () => {
  const c = chain(base, "s1");
  const reordered = [c[0], c[2], c[1]];
  const { problems } = verifyCaptureChain(reordered);
  assert.ok(problems.length >= 1, "재정렬 미탐지");
});

// ── 레거시(체인 없는 줄) ──
check("레거시 줄 → 검증불가로 분리(차단 아님)", () => {
  const legacyRecs = base.map((r) => ({ ...r })); // seq/entryHash 없음
  const { problems, verified, legacy } = verifyCaptureChain(legacyRecs);
  assert.equal(problems.length, 0, "레거시가 문제로 잡힘");
  assert.equal(verified, 0);
  assert.equal(legacy, 3);
});

// ── degraded 마커는 행위에서 제외(영수증 byte 안전) ──
check("capture-degraded 는 actions 에 안 들어감", () => {
  const recs = [
    { ts: "t1", phase: "post", tool: "Read", op: "read", path: ".env" },
    { ts: "t2", phase: "post", tool: "(capture)", op: "capture-degraded", reason: "stdin 파싱 실패" },
  ];
  const { actions, actionsSummary } = aggregateActions(recs);
  assert.equal(actions.length, 1, "degraded 가 행위로 셈");
  assert.equal(actionsSummary.total, 1);
  assert.equal(actions[0].flag, "READ_SECRET_FILE");
});

// ── 체인 필드가 actions 에 누출되지 않음(=영수증 불변 보증) ──
check("체인 필드(seq/prevHash/entryHash/sessionId)는 actions 에 누출 안 됨", () => {
  const chained = chain([base[2]], "s1")[0]; // write 레코드 + 체인필드
  const plain = { ...base[2] }; // 동일 내용·체인필드 없음
  const a1 = aggregateActions([chained]).actions[0];
  const a2 = aggregateActions([plain]).actions[0];
  assert.deepEqual(a1, a2, "체인 유무로 CaptureAction 이 달라짐(영수증 회귀 위험)");
  assert.equal(a1.seq, undefined);
  assert.equal(a1.entryHash, undefined);
});

// ── 커버리지 단일 출처 ──
check("COVERED_TOOLS = 훅 matcher 와 동일 7종", () => {
  assert.deepEqual([...COVERED_TOOLS], ["Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "NotebookRead"]);
  // classifyEvent 가 실제로 이 도구들을 분류하는지(대표 2종)
  assert.equal(classifyEvent({ tool_name: "Read", tool_input: { file_path: "/x/.env" } }, "post", "t").length, 1);
  assert.equal(classifyEvent({ tool_name: "WebFetch", tool_input: { url: "http://x" } }, "post", "t").length, 0); // 범위 밖
});

if (fail.length) {
  console.error(`capture-chain: ${fail.length} FAIL\n  ` + fail.join("\n  "));
  process.exit(1);
}
console.log(`capture-chain: ${pass} pass, 0 fail`);
