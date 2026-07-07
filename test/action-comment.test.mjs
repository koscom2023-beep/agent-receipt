// PR 코멘트 본문 생성기 — council 2026-07-03 결정 4(기계 투영만·MARKER upsert) 수락 기준.
// `node test/action-comment.test.mjs`.
import assert from "node:assert/strict";
import { buildBody, MARKER } from "../scripts/pr-comment-body.mjs";

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

const passReceipt = {
  verdict: "pass",
  subject: "release claims",
  summary: { verified: 3, failed: 0, advisory: 1 },
  results: [{ statement: "ok", verdict: "verified", checks: { citation: "verified" } }],
  receiptId: "abcdef0123456789deadbeef",
  input: { sha256: "1234567890abcdef1234" },
  tool: { name: "agent-receipt", version: "0.14.0" },
};

check("MARKER 가 첫 줄(upsert 식별자)", () => {
  const b = buildBody(passReceipt);
  assert.ok(b.startsWith(MARKER + "\n"));
});

check("pass: ✅ + summary 카운트 투영·failed 섹션 없음", () => {
  const b = buildBody(passReceipt);
  assert.ok(b.includes("✅"));
  assert.ok(b.includes("verified 3 · failed 0 · advisory 1"));
  assert.ok(!b.includes("failed claims"));
});

check("fail: ❌ + 실패 주장 statement + 실패 check 종류 투영", () => {
  const r = {
    ...passReceipt,
    verdict: "fail",
    summary: { verified: 1, failed: 2, advisory: 0 },
    results: [
      { statement: "ok", verdict: "verified", checks: { citation: "verified" } },
      { statement: "숫자가 안 맞는 주장", verdict: "failed", checks: { number: "failed (mismatch)", citation: "verified" } },
      { statement: "출처에 없는 인용", verdict: "failed", checks: { citation: "not-found" } },
    ],
  };
  const b = buildBody(r);
  assert.ok(b.includes("❌"));
  assert.ok(b.includes("failed claims** (2)"));
  assert.ok(b.includes("숫자가 안 맞는 주장"));
  assert.ok(b.includes("number: failed (mismatch)"));
  assert.ok(b.includes("출처에 없는 인용"));
  assert.ok(!b.includes("ok —"), "verified 주장이 실패 목록에 섞임");
});

check("본문은 영수증 필드만 — receiptId/sha/버전 12자 투영·자유 서술 금지", () => {
  const b = buildBody(passReceipt);
  assert.ok(b.includes("abcdef012345"));
  assert.ok(b.includes("1234567890ab"));
  assert.ok(b.includes("0.14.0"));
  assert.ok(b.includes("mechanical projection"));
  assert.ok(!/saved|절감|token[s]? saved/i.test(b), "절감/마케팅 문구 발견(결정 4 위반)");
});

check("실패 6건 이상 → 5건 + '… N more' 절단", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ statement: `실패 ${i}`, verdict: "failed", checks: { hash: "failed" } }));
  const b = buildBody({ ...passReceipt, verdict: "fail", results: many });
  assert.ok(b.includes("… 3 more"));
});

check("결손 필드 내성(빈 영수증) — 크래시 없이 마커+verdict 만", () => {
  const b = buildBody({});
  assert.ok(b.startsWith(MARKER));
  assert.ok(b.includes("?"));
});

// ════════ v0.21 결정9 — proof 링크 슬롯·대칭차·no-receipt 경고(전부 opt-in) ════════
import { fileMismatch } from "../scripts/pr-comment-body.mjs";

check("opts 비면 기존과 byte 동일(기존 사용자 불변)", () => {
  assert.equal(buildBody(passReceipt), buildBody(passReceipt, {}));
});
check("proof-url 슬롯 — 호출자 제공 값만(발명 0)", () => {
  const b = buildBody(passReceipt, { proofUrl: "https://example.test/pb" });
  assert.ok(b.includes("**proof**: https://example.test/pb"));
  assert.ok(!buildBody(passReceipt).includes("**proof**"), "미제공 시 줄 없음");
});
check("fileMismatch — 대칭차·정렬·판단 0", () => {
  const m = fileMismatch(["b.ts", "a.ts", "same.ts"], ["same.ts", "z.ts"]);
  assert.deepEqual(m, { prOnly: ["a.ts", "b.ts"], receiptOnly: ["z.ts"] });
});
check("mismatch 섹션 — 일치=✅·차이=목록·10건 절단", () => {
  const eq = buildBody(passReceipt, { mismatch: { prOnly: [], receiptOnly: [] } });
  assert.ok(eq.includes("match ✅") && eq.includes("not a judgment"));
  const many = { prOnly: Array.from({ length: 12 }, (_, i) => `p${i}.ts`), receiptOnly: ["r.ts"] };
  const b = buildBody(passReceipt, { mismatch: many });
  assert.ok(b.includes("in PR only: `p0.ts`") && b.includes("… 2 more (PR only)") && b.includes("in receipt only: `r.ts`"));
});
check("no-receipt 경고 — 부재를 서술(판단 없음)", () => {
  const b = buildBody(passReceipt, { workReceiptMissing: true });
  assert.ok(b.includes("no work receipt attached") && b.includes("not judged"));
});

// ════════ 배치B-8 — 검토 배지 + 1줄 요약(--summary) ════════
import { buildSummaryLine } from "../scripts/pr-comment-body.mjs";
check("review 배지 — 기계 투영 + 자가보고 라벨", () => {
  const b = buildBody(passReceipt, { review: { status: "rejected", reviewer: "황교동" } });
  assert.ok(b.includes("**review**: ✗ rejected by 황교동") && b.includes("not an authority"));
  assert.ok(!buildBody(passReceipt).includes("**review**"), "미제공=배지 없음");
});
check("buildSummaryLine — 1줄·기계 투영·review/proof 슬롯", () => {
  const l = buildSummaryLine(passReceipt, { review: { status: "approved", reviewer: "x" }, proofUrl: "https://e.test/p" });
  assert.ok(!l.includes("\n"), "1줄");
  assert.ok(l.includes("✅") && l.includes("verified 3") && l.includes("review: approved(self-reported)") && l.includes("proof: https://e.test/p") && l.includes("receiptId abcdef012345"));
  assert.ok(!/saved|절감|추천|권장/i.test(l), "판단·마케팅어 0");
});
console.log(`action-comment.test: ${pass} passed, ${fail.length} failed`);
if (fail.length) {
  for (const f of fail) console.error("  ✗ " + f);
  process.exit(1);
}
