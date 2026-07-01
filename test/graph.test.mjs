// Evidence Graph 조회레이어 — verification-receipt 디렉터리 로드/필터 + SDK 배럴 export 확인.
// `node test/graph.test.mjs`.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReceipts, queryReceipts, buildViewData, buildGraphHtml } from "../dist/graph.js";
import { evaluateClaim, SCHEMA_VERSION } from "../dist/index.js"; // SDK 배럴(L7 씨앗)

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass++; } catch (e) { fail.push(`${name}: ${e.message}`); } };

// 임시 디렉터리에 verification-receipt 3개 + 비-receipt 1개.
const dir = mkdtempSync(join(tmpdir(), "argraph-"));
const mk = (name, o) => writeFileSync(join(dir, name), JSON.stringify(o));
mk("r1.json", { kind: "verification-receipt", receiptId: "id1", subject: "A", verdict: "pass", surface: "research", input: { sha256: "shaA" }, provenance: { reported: { model: "claude", commit: "c1" } } });
mk("r2.json", { kind: "verification-receipt", receiptId: "id2", subject: "B", verdict: "fail", surface: "research", input: { sha256: "shaB" }, provenance: { reported: { model: "gpt", commit: "c1" } } });
mk("r3.json", { kind: "verification-receipt", receiptId: "id3", subject: "C", verdict: "pass", surface: "council", input: { sha256: "shaA" }, provenance: { reported: { model: "claude", commit: "c2" } } });
mk("other.json", { kind: "something-else" }); // skip 대상

const all = loadReceipts(dir);

check("loadReceipts: verification-receipt 만 로드(비-receipt skip)", () => assert.equal(all.length, 3));
check("query commit=c1 → 2건", () => assert.equal(queryReceipts(all, { commit: "c1" }).length, 2));
check("query input=shaA → 2건(같은 입력 검증 이력)", () => assert.equal(queryReceipts(all, { input: "shaA" }).length, 2));
check("query model=claude → 2건", () => assert.equal(queryReceipts(all, { model: "claude" }).length, 2));
check("query receiptId=id2 → 1건", () => {
  const r = queryReceipts(all, { receiptId: "id2" });
  assert.equal(r.length, 1); assert.equal(r[0].verdict, "fail");
});
check("복합 필터 commit=c1 & model=claude → 1건", () => assert.equal(queryReceipts(all, { commit: "c1", model: "claude" }).length, 1));
check("loadReceipts: 없는 디렉터리 → []", () => assert.deepEqual(loadReceipts(join(dir, "nope")), []));

// ── L6 정적 HTML 뷰어 ──
check("buildViewData: 각 행에 integrity(replay 스냅샷) 포함", () => {
  const v = buildViewData(dir);
  assert.equal(v.length, 3);
  assert.equal(typeof v[0].integrity.contentHashOk, "boolean");
});
check("buildGraphHtml: 자체완결 HTML·데이터 임베드", () => {
  const html = buildGraphHtml([{ receiptId: "idXYZ", subject: "S", verdict: "pass", surface: "research", model: "m", commit: "c", inputSha: "s", integrity: { contentHashOk: true, receiptIdOk: true, inputMatch: null, commitRecheck: null }, claims: [] }]);
  assert.ok(html.includes("<!doctype html>") && html.includes("idXYZ") && html.includes("Evidence Graph"));
});
check("buildGraphHtml: 외부 리소스/서버 없음(자체완결)", () => {
  const html = buildGraphHtml([]);
  assert.ok(!html.includes("<script src") && !html.includes("<link "));
});
check("Evidence Browser: 실패 check → failedChecks + suggestedFixes(고정 매핑)", () => {
  const d2 = mkdtempSync(join(tmpdir(), "argraph2-"));
  writeFileSync(join(d2, "r.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "idE", subject: "E", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found", number: "verified", hash: "mismatch" } }] }));
  const v = buildViewData(d2);
  const cl = v[0].claims[0];
  assert.deepEqual([...cl.failedChecks].sort(), ["citation", "hash"]);
  assert.equal(cl.suggestedFixes.length, 2);
  rmSync(d2, { recursive: true, force: true });
});

// ── L7 SDK 배럴: 외부 import 가능 ──
check("SDK: evaluateClaim import 동작", () => {
  const e = evaluateClaim({ quotedText: "sky is blue" }, "the sky is blue");
  assert.equal(e.verified, true);
});
check("SDK: SCHEMA_VERSION export", () => assert.equal(SCHEMA_VERSION, "evidence/1"));

rmSync(dir, { recursive: true, force: true });

if (fail.length) { console.error(`graph: ${pass} pass, ${fail.length} FAIL`); for (const f of fail) console.error("  ✗ " + f); process.exit(1); }
console.log(`graph: ${pass} pass ✅`);
