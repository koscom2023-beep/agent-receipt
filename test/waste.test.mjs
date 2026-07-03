// 반복 낭비 분석(analyzeWaste) — council 2026-07-03 증분1 수락 기준.
// fixture: 재독 11(그중 편집 개입 재독은 미카운트)·동일 test 명령 4회·실패 반복 2회 심고 정확 카운트 재현.
// `node test/waste.test.mjs`.
import assert from "node:assert/strict";
import { analyzeWaste, wasteDisplayLines, classifyEvent } from "../dist/capture.js";

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

const read = (path, phase = "post") => ({ ts: "T", phase, tool: "Read", op: "read", path });
const write = (path, phase = "post") => ({ ts: "T", phase, tool: "Edit", op: "write", path });
const cmd = (cmdHash, cmdKind = "test", phase = "post") => ({ ts: "T", phase, tool: "Bash", op: "command", cmdHash, cmdKind });
const failRec = (tool, path) => ({ ts: "T", phase: "fail", tool, op: "command", path });

check("재독: 사이 편집 없는 재독만 카운트(편집 후 재독=정상·리셋)", () => {
  const w = analyzeWaste([
    read("a.ts"), read("a.ts"), read("a.ts"), // 재독 2
    write("a.ts"),
    read("a.ts"), // 편집 후 재독 — 미카운트
    read("a.ts"), // 재독 1 (누적 3)
    read("b.ts"), // 단독 — 0
  ]);
  assert.equal(w.rereads.length, 1);
  assert.equal(w.rereads[0].path, "a.ts");
  assert.equal(w.rereads[0].repeats, 3);
});

check("fixture 11회 재독 → 정확히 11", () => {
  const recs = [read("x.md")];
  for (let i = 0; i < 11; i++) recs.push(read("x.md"));
  const w = analyzeWaste(recs);
  assert.equal(w.rereads[0].repeats, 11);
});

check("동일 명령 4회 → count 4·1회짜리는 제외", () => {
  const w = analyzeWaste([cmd("h1"), cmd("h1"), cmd("h1"), cmd("h1"), cmd("h2", "build")]);
  assert.equal(w.repeatedCommands.length, 1);
  assert.equal(w.repeatedCommands[0].count, 4);
  assert.equal(w.repeatedCommands[0].cmdKind, "test");
});

check("실패 반복 2회(동일 대상) 탐지·1회는 제외", () => {
  const w = analyzeWaste([failRec("Bash", "run.sh"), failRec("Bash", "run.sh"), failRec("Bash", "other.sh")]);
  assert.equal(w.repeatedFailures.length, 1);
  assert.equal(w.repeatedFailures[0].count, 2);
});

check("pre+post 이중 기록 dedupe — post 있으면 post 만 사용(이중 카운트 금지)", () => {
  const w = analyzeWaste([read("a.ts", "pre"), read("a.ts", "post"), read("a.ts", "pre"), read("a.ts", "post")]);
  assert.equal(w.rereads.length ? w.rereads[0].repeats : 0, 1, "pre+post 를 이중 카운트함");
});

check("pre 만 있는 설치(post 0) → pre 로 폴백", () => {
  const w = analyzeWaste([read("a.ts", "pre"), read("a.ts", "pre")]);
  assert.equal(w.rereads[0].repeats, 1);
});

check("classifyEvent Bash → cmdHash 16hex + cmdKind(본문 미저장)", () => {
  const recs = classifyEvent({ tool_name: "Bash", tool_input: { command: "npx vitest run src/" } }, "post", "T");
  assert.equal(recs[0].op, "command");
  assert.match(recs[0].cmdHash, /^[0-9a-f]{16}$/);
  assert.equal(recs[0].cmdKind, "test");
  assert.ok(!JSON.stringify(recs).includes("vitest"), "명령 본문이 레코드에 저장됨(값 미저장 원칙 위반)");
});

check("cmdKind 분류: build/lint/install/other", () => {
  const kind = (c) => classifyEvent({ tool_name: "Bash", tool_input: { command: c } }, "post", "T")[0].cmdKind;
  assert.equal(kind("npm run build"), "build");
  assert.equal(kind("npx eslint ."), "lint");
  assert.equal(kind("npm ci"), "install");
  assert.equal(kind("git status"), "other");
});

check("빈 로그 → 세 범주 전부 빈 배열(표시 0줄)", () => {
  const w = analyzeWaste([]);
  assert.equal(wasteDisplayLines(w).length, 0);
});

check("표시줄: 환산·인과 주장 없음(횟수만)·범주당 최대 5줄", () => {
  const many = [];
  for (let p = 0; p < 8; p++) for (let i = 0; i < 3; i++) many.push(read(`f${p}.ts`));
  const lines = wasteDisplayLines(analyzeWaste(many));
  assert.equal(lines.length, 5, "범주 상한 5줄 위반");
  assert.ok(lines.every((l) => !/token|절감|saved|아꼈/.test(l)), "환산/절감 문구 발견(결정 4 위반)");
});

console.log(`waste.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
