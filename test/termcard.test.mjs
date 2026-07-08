// 터미널 판정 카드 — 폭 계산·자르기·색 안전·판정 3중신호·비TTY 불변.
import assert from "node:assert/strict";
import { dispWidth, clip, useColor, renderTermCard } from "../dist/termcard.js";

// ── dispWidth: CJK/이모지=2, ASCII=1, ANSI 무시 ──
assert.equal(dispWidth("abc"), 3, "ASCII");
assert.equal(dispWidth("계약"), 4, "한글 2칸");
assert.equal(dispWidth("a계b"), 4, "혼합");
assert.equal(dispWidth("\x1b[32mPASS\x1b[0m"), 4, "ANSI 무시");
assert.equal(dispWidth("✅"), 2, "이모지 2칸");

// ── clip: 표시폭 초과 시 … , 이하면 그대로 ──
assert.equal(clip("hello", 10), "hello", "짧으면 그대로");
assert.equal(clip("hello world", 6), "hello…", "ASCII 자름");
assert.ok(dispWidth(clip("계약 준수 검사 통과 경고 없음", 10)) <= 10, "한글 자름 폭 준수");
assert.ok(clip("계약 준수 검사 통과", 8).endsWith("…"), "… 표시");

// ── useColor: NO_COLOR/FORCE_COLOR/isTTY ──
{
  const save = { NO: process.env.NO_COLOR, FC: process.env.FORCE_COLOR };
  delete process.env.NO_COLOR; delete process.env.FORCE_COLOR;
  assert.equal(useColor({ isTTY: true }), true, "TTY=색");
  assert.equal(useColor({ isTTY: false }), false, "비TTY=무색(파이프/CI)");
  process.env.NO_COLOR = "1";
  assert.equal(useColor({ isTTY: true }), false, "NO_COLOR=무색");
  delete process.env.NO_COLOR; process.env.FORCE_COLOR = "1";
  assert.equal(useColor({ isTTY: false }), true, "FORCE_COLOR=강제 색");
  // 복원
  delete process.env.FORCE_COLOR; delete process.env.NO_COLOR;
  if (save.NO !== undefined) process.env.NO_COLOR = save.NO;
  if (save.FC !== undefined) process.env.FORCE_COLOR = save.FC;
}

// ── renderTermCard: 판정 3중신호·박스·계약·무색/유색 ──
function mkReceipt(verdict, ok = true, checks = [{ name: "tsc", ok: true }]) {
  return {
    contractId: "demo", title: null, ok,
    touched: ["a.ts"], staged: [], untracked: [], magnitude: { added: 5, deleted: 2, filesChanged: 1, newFiles: 0 },
    criticalPaths: [], checks, contentHash: "sha256:abcdef0123456789abcdef",
    verdict: verdict ? { verdict, reasons: ["계약 준수 · 검사 통과"] } : undefined,
    contractSnapshot: { contractId: "demo", kind: "implementation", allowedGlobs: 1, deniedGlobs: [".env*"], forbiddenActions: ["push"], budget: null, contractHash: "sha256:cc" },
  };
}
{
  const noColor = renderTermCard(mkReceipt("PASS"), { color: false });
  assert.ok(noColor.includes("✅") && noColor.includes("PASS"), "PASS 아이콘+라벨(3중 중 2)");
  assert.ok(noColor.includes("┌") && noColor.includes("│") && noColor.includes("└"), "박스 드로잉");
  assert.ok(noColor.includes("implementation"), "계약 kind");
  assert.ok(noColor.includes("denied: .env*"), "denied 표기");
  assert.ok(!noColor.includes("\x1b["), "color:false=ANSI 코드 없음(파이프 안전)");

  const color = renderTermCard(mkReceipt("PASS"), { color: true });
  assert.ok(color.includes("\x1b[32m"), "color:true=초록 ANSI(3중 중 색)");

  // FAIL=빨강·미화 금지
  const fail = renderTermCard(mkReceipt("FAIL", false), { color: true });
  assert.ok(fail.includes("❌") && fail.includes("FAIL") && fail.includes("\x1b[31m"), "FAIL=빨강 ❌ 크게");

  // INCOMPLETE=회색 ◌
  const inc = renderTermCard(mkReceipt("INCOMPLETE"), { color: false });
  assert.ok(inc.includes("◌") && inc.includes("INCOMPLETE"), "INCOMPLETE ◌");

  // verdict 없으면 receipt.ok 로 폴백
  const noV = renderTermCard(mkReceipt(null, true), { color: false });
  assert.ok(noV.includes("PASS"), "verdict 없음→ok=PASS 폴백");

  // 모든 콘텐츠 행의 우변 정렬(같은 표시폭) — 긴 제목도 안 밀림
  const wide = renderTermCard({ ...mkReceipt("PASS"), title: "아주 긴 제목 ".repeat(10) }, { color: false });
  const rows = wide.split("\n").filter((l) => l.includes("│"));
  const widths = new Set(rows.map((l) => dispWidth(l)));
  assert.equal(widths.size, 1, "모든 테두리 행 표시폭 동일(우변 정렬)");
}

console.log("termcard.test: OK (폭·자르기·색안전·판정3중·정렬·비TTY불변)");
