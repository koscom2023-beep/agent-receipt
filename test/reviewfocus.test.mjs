// 리뷰 압축 + 확인 신호 — council 2026-07-03 R1~R3 수락 기준. `node test/reviewfocus.test.mjs`.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildReviewFocus, focusLines, collectRedFlags, redFlagLine, FOCUS_MIN_TOTAL } from "../dist/reviewfocus.js";

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

const st = (added, deleted = 0) => ({ added, deleted });

check("임계 미달(total<4) → null (출력 불변)", () => {
  const f = buildReviewFocus({ touched: ["a.ts", "b.ts", "c.ts"], untracked: [], riskHits: ["a.ts"], perFile: new Map() });
  assert.equal(f, null);
  assert.equal(FOCUS_MIN_TOTAL, 4);
});

check("티어 순서: 위험경로 > 매니페스트 > 대형diff > 신규", () => {
  const f = buildReviewFocus({
    touched: ["src/big.ts", "package.json", "src/auth.ts", "src/tiny.ts"],
    untracked: ["src/new.ts"],
    riskHits: ["src/auth.ts"],
    perFile: new Map([
      ["src/big.ts", st(200, 30)],
      ["package.json", st(2)],
      ["src/auth.ts", st(5)],
      ["src/tiny.ts", st(1)],
      ["src/new.ts", st(10)],
    ]),
  });
  assert.deepEqual(f.top.map((x) => x.path), ["src/auth.ts", "package.json", "src/big.ts"]);
  assert.deepEqual(f.top.map((x) => x.tier), [1, 2, 3]);
  assert.ok(f.rest.includes("src/tiny.ts") && f.rest.includes("src/new.ts"), "부수 목록에 나머지 누락");
  assert.equal(f.total, 5);
});

check("테스트/문서는 대형 diff·신규여도 하위(부수)", () => {
  const f = buildReviewFocus({
    touched: ["test/x.test.ts", "docs/y.md", "src/a.ts", "src/b.ts"],
    untracked: [],
    riskHits: [],
    perFile: new Map([
      ["test/x.test.ts", st(500)],
      ["docs/y.md", st(300)],
      ["src/a.ts", st(100)],
      ["src/b.ts", st(90)],
    ]),
  });
  assert.deepEqual(f.top.map((x) => x.path), ["src/a.ts", "src/b.ts"]);
  assert.ok(f.rest.includes("test/x.test.ts") && f.rest.includes("docs/y.md"));
});

check("티어 해당 0 → null (정렬 근거 없으면 섹션 생략)", () => {
  const f = buildReviewFocus({
    touched: ["a.md", "b.md", "c.md", "d.md"],
    untracked: [],
    riskHits: [],
    perFile: new Map(),
  });
  assert.equal(f, null);
});

check("표시줄: '보증 아님' 명시·절감 %/시간 환산 없음", () => {
  const f = buildReviewFocus({
    touched: ["src/a.ts", "src/b.ts", "src/c.ts", "package.json"],
    untracked: [],
    riskHits: ["src/a.ts"],
    perFile: new Map([["src/a.ts", st(10)]]),
  });
  const L = focusLines(f);
  assert.ok(L[0].includes("보증 아님"));
  assert.ok(L.every((l) => !/절감|saved|%\s*감소/.test(l)));
});

// ── 확인 신호: 진짜 git repo 에서 ──
const mkGitRepo = () => {
  const d = mkdtempSync(join(tmpdir(), "ar-rf-"));
  const run = (args) => execFileSync("git", args, { cwd: d, encoding: "utf8" });
  run(["init", "-q"]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base"]);
  return { d, run };
};

check("테스트 파일에 .only 추가 → 검출 / 기존 skip 무수정 → 미검출(added-only)", () => {
  const { d, run } = mkGitRepo();
  mkdirSync(join(d, "test"), { recursive: true });
  writeFileSync(join(d, "test", "old.test.ts"), "it.skip('legacy', () => {});\n"); // 기존부터 skip
  run(["add", "."]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
  writeFileSync(join(d, "test", "old.test.ts"), "it.skip('legacy', () => {});\nit.only('sneaky', () => {});\n"); // only 추가
  const prev = process.cwd();
  process.chdir(d);
  try {
    const rf = collectRedFlags(["test/old.test.ts"], [], d);
    assert.equal(rf.skipOnly.length, 1);
    assert.equal(rf.skipOnly[0].count, 1, "기존 skip 을 재고함(added-only 위반) 또는 only 미검출");
  } finally {
    process.chdir(prev);
  }
});

check("신규(untracked) 테스트 파일의 skip 도 검출(전체=추가줄)", () => {
  const { d } = mkGitRepo();
  mkdirSync(join(d, "test"), { recursive: true });
  writeFileSync(join(d, "test", "new.spec.ts"), "describe.skip? no; \nit.skip('a', () => {});\n");
  const prev = process.cwd();
  process.chdir(d);
  try {
    const rf = collectRedFlags([], ["test/new.spec.ts"], d);
    assert.equal(rf.skipOnly.length, 1);
  } finally {
    process.chdir(prev);
  }
});

check("의존성 추가 → 이름 검출·scripts 변경은 오탐 없음(키 집합 차)", () => {
  const { d, run } = mkGitRepo();
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", dependencies: { a: "1.0.0" }, scripts: { test: "echo" } }, null, 2));
  run(["add", "."]);
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ name: "x", dependencies: { a: "1.0.0", lodash: "4.0.0" }, devDependencies: { vitest: "1.0.0" }, scripts: { test: "echo changed", build: "tsc" } }, null, 2),
  );
  const prev = process.cwd();
  process.chdir(d);
  try {
    const rf = collectRedFlags(["package.json"], [], d);
    assert.deepEqual(rf.depsAdded, ["lodash", "vitest"]);
  } finally {
    process.chdir(prev);
  }
});

check("신호 0 → redFlagLine null / 있으면 '관찰·판정 아님' 프레이밍", () => {
  assert.equal(redFlagLine({ skipOnly: [], depsAdded: [] }), null);
  const l = redFlagLine({ skipOnly: [{ path: "t.test.ts", count: 2 }], depsAdded: ["x"] });
  assert.ok(l.includes("관찰·판정 아님"));
  assert.ok(l.includes("skip/only 추가 2곳"));
  assert.ok(l.includes("의존성 추가 1개(x)"));
});

console.log(`reviewfocus.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
