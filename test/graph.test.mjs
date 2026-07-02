// Evidence Graph 조회레이어 — verification-receipt 디렉터리 로드/필터 + SDK 배럴 export 확인.
// `node test/graph.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReceipts, queryReceipts, buildViewData, buildGraphHtml, buildSummary, buildFailures, buildIndexes, buildGraph } from "../dist/graph.js";
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
check("buildGraphHtml: Dashboard-first 자체완결 HTML·데이터 임베드", () => {
  const html = buildGraphHtml([{ receiptId: "idXYZ", subject: "S", verdict: "pass", surface: "research", model: "m", commit: "c", inputSha: "s", integrity: { contentHashOk: true, receiptIdOk: true, inputMatch: null, commitRecheck: null }, claims: [] }]);
  assert.ok(html.includes("<!doctype html>") && html.includes("idXYZ") && html.includes("Evidence Browser") && html.includes("Most Failed"));
});
check("buildGraphHtml: 외부 리소스/서버 없음(자체완결)", () => {
  const html = buildGraphHtml([]);
  assert.ok(!html.includes("<script src") && !html.includes("<link "));
});
check("Evidence Browser: Reason 객체(check→reason→evidence→hint)", () => {
  const d2 = mkdtempSync(join(tmpdir(), "argraph2-"));
  writeFileSync(join(d2, "r.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "idE", subject: "E", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found", number: "verified", hash: "mismatch" }, evidence: { hash: { expected: "aa", actual: "bb" } } }] }));
  const v = buildViewData(d2);
  const cl = v[0].claims[0];
  assert.deepEqual(cl.failures.map((f) => f.check).sort(), ["citation", "hash"]);
  const cit = cl.failures.find((f) => f.check === "citation");
  assert.ok(cit.reason && cit.hint && cit.status === "not-found");
  const hashF = cl.failures.find((f) => f.check === "hash");
  assert.deepEqual(hashF.evidence, { expected: "aa", actual: "bb" }); // evidence 흐름
  assert.equal(cit.evidence, null); // evidence 없는 check → null
  rmSync(d2, { recursive: true, force: true });
});
check("buildSummary/buildFailures: Dashboard 집계 + failure-first", () => {
  const d3 = mkdtempSync(join(tmpdir(), "argraph3-"));
  writeFileSync(join(d3, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "x1", subject: "X", verdict: "fail", surface: "research", input: { sha256: "s" }, provenance: { reported: { model: "m" } }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found" } }] }));
  const v = buildViewData(d3);
  const s = buildSummary(v);
  assert.equal(s.total, 1); assert.equal(s.fail, 1); assert.equal(s.mostFailedCheck, "citation");
  const f = buildFailures(v);
  assert.equal(f.length, 1); assert.deepEqual(f[0].affectedClaims, [1]); assert.ok(f[0].reasons[0].includes("citation"));
  rmSync(d3, { recursive: true, force: true });
});
check("buildIndexes: byCheck/byModel/bySubject/byCommit/byReason(순회 없이 lookup)", () => {
  const d4 = mkdtempSync(join(tmpdir(), "argraph4-"));
  writeFileSync(join(d4, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "x", subject: "Proj", verdict: "fail", surface: "research", input: { sha256: "s" }, provenance: { reported: { model: "m", commit: "c9" } }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found", hash: "mismatch" } }] }));
  const ix = buildIndexes(buildViewData(d4));
  assert.equal(ix.byCheck.citation.length, 1);
  assert.equal(ix.byCheck.hash.length, 1);
  assert.equal(ix.byModel.m.length, 2); // 두 실패 모두 model m
  assert.equal(ix.bySubject.Proj.length, 2);
  assert.equal(ix.byCommit.c9.length, 2);
  rmSync(d4, { recursive: true, force: true });
});

// ── L6 v2: 진짜 edge layer — buildGraph {nodes, edges} ──
check("buildGraph: receipt 노드 3 + same_input(재해시 불가→reported)·same_commit(reported·세탁금지)", () => {
  const g = buildGraph(buildViewData(dir));
  assert.equal(g.nodes.filter((n) => n.type === "receipt").length, 3);
  const si = g.edges.filter((e) => e.type === "same_input");
  assert.equal(si.length, 1); // r1↔r3 (shaA)
  assert.equal(si[0].tier, "reported"); // 입력 재해시 불가 → 기재값 신뢰 = reported(세탁 금지)
  assert.ok([si[0].from, si[0].to].sort().join() === "receipt:id1,receipt:id3");
  const sc = g.edges.filter((e) => e.type === "same_commit");
  assert.equal(sc.length, 1); // r1↔r2 (c1)
  assert.equal(sc[0].tier, "reported"); // 자가보고를 검증사실로 세탁 금지
  assert.equal(g.edges.filter((e) => e.type === "reverifies").length, 0); // verifiedAt 없음 → 방향 단정 불가
  assert.ok(g.nodes.filter((n) => n.type === "receipt").every((n) => n.tampered === true)); // 봉인 없음 → 표시(숨김 아님)
});
check("buildGraph: same_input=verified 는 양쪽 입력 재해시 일치(inputMatch)일 때만", () => {
  const d8 = mkdtempSync(join(tmpdir(), "argraph8-"));
  const inp = join(d8, "input.txt");
  writeFileSync(inp, "INPUT CONTENT");
  const sha = createHash("sha256").update("INPUT CONTENT").digest("hex");
  writeFileSync(join(d8, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "vA", subject: "A", verdict: "pass", surface: "research", input: { file: inp, sha256: sha } }));
  writeFileSync(join(d8, "b.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "vB", subject: "B", verdict: "fail", surface: "research", input: { file: inp, sha256: sha } }));
  const g = buildGraph(buildViewData(d8));
  const si = g.edges.filter((e) => e.type === "same_input");
  assert.equal(si.length, 1);
  assert.equal(si[0].tier, "verified"); // 우리가 실제 재해시해 확인
  rmSync(d8, { recursive: true, force: true });
});
check("buildGraph: 접힘이 최신 verifiedAt 유지 + occurrences 보존(나중 재검증 소실 금지)", () => {
  const d9 = mkdtempSync(join(tmpdir(), "argraph9-"));
  const base = { kind: "verification-receipt", surface: "research", input: { sha256: "sameS" } };
  writeFileSync(join(d9, "a.json"), JSON.stringify({ ...base, receiptId: "P", subject: "A", verdict: "pass", verifiedAt: "2026-07-01T00:00:00Z" }));
  writeFileSync(join(d9, "b.json"), JSON.stringify({ ...base, receiptId: "F", subject: "A", verdict: "fail", verifiedAt: "2026-07-02T00:00:00Z" }));
  writeFileSync(join(d9, "c.json"), JSON.stringify({ ...base, receiptId: "P", subject: "A", verdict: "pass", verifiedAt: "2026-07-03T00:00:00Z" })); // 7/3 재검증=pass
  const g = buildGraph(buildViewData(d9));
  const p = g.nodes.find((n) => n.id === "receipt:P");
  assert.equal(p.verifiedAt, "2026-07-03T00:00:00Z"); // 최신 행 유지(가장 이른 행 아님)
  assert.equal(p.occurrences, 2); // 접힌 기록 보존
  assert.deepEqual(p.verifiedAtAll, ["2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z"]);
  const rv = g.edges.filter((e) => e.type === "reverifies");
  assert.equal(rv.length, 1); // 체인 종점=최신 pass(F 가 종점이면 최신 상태가 거꾸로 읽힘)
  assert.equal(rv[0].from, "receipt:P");
  assert.equal(rv[0].to, "receipt:F");
  assert.equal(rv[0].tier, "reported"); // verifiedAt=자가보고 타임스탬프
  rmSync(d9, { recursive: true, force: true });
});
check("buildGraph: receiptId 결측은 접지 않음(file 노드) — 영수증/claim 소실 금지", () => {
  const dA = mkdtempSync(join(tmpdir(), "argraphA-"));
  writeFileSync(join(dA, "a.json"), JSON.stringify({ kind: "verification-receipt", subject: "AAA", verdict: "fail", surface: "research", input: { sha256: "s1" }, results: [{ statement: "S-A", verdict: "failed", checks: { citation: "not-found" } }] }));
  writeFileSync(join(dA, "b.json"), JSON.stringify({ kind: "verification-receipt", subject: "BBB", verdict: "fail", surface: "research", input: { sha256: "s2" }, results: [{ statement: "S-B", verdict: "failed", checks: { number: "mismatch" } }] }));
  const g = buildGraph(buildViewData(dA));
  const rids = g.nodes.filter((n) => n.type === "receipt").map((n) => n.id).sort();
  assert.deepEqual(rids, ["receipt:file:a.json", "receipt:file:b.json"]);
  assert.equal(g.nodes.filter((n) => n.type === "claim").length, 2); // 둘 다 보존
  rmSync(dA, { recursive: true, force: true });
});
check("buildGraph: 오프셋 ISO-8601 도 실제 시간순으로 방향 판정(문자열순 아님)", () => {
  const dB = mkdtempSync(join(tmpdir(), "argraphB-"));
  const base = { kind: "verification-receipt", surface: "research", input: { sha256: "offS" } };
  writeFileSync(join(dB, "a.json"), JSON.stringify({ ...base, receiptId: "rA", subject: "A", verdict: "pass", verifiedAt: "2026-07-01T10:00:00+09:00" })); // =01:00Z 먼저
  writeFileSync(join(dB, "b.json"), JSON.stringify({ ...base, receiptId: "rB", subject: "A", verdict: "fail", verifiedAt: "2026-07-01T05:00:00Z" })); // 4시간 뒤
  const g = buildGraph(buildViewData(dB));
  const rv = g.edges.filter((e) => e.type === "reverifies");
  assert.equal(rv.length, 1);
  assert.equal(rv[0].from, "receipt:rB"); // 나중(05:00Z)
  assert.equal(rv[0].to, "receipt:rA"); // 먼저(01:00Z)
  rmSync(dB, { recursive: true, force: true });
});
check("buildGraph: 완전 동률 중복은 file tie-break(파일시스템 열거 순서 비의존)", () => {
  const dC = mkdtempSync(join(tmpdir(), "argraphC-"));
  const base = { kind: "verification-receipt", receiptId: "dupX", verdict: "pass", surface: "research", input: { sha256: "s" }, verifiedAt: "2026-07-01T00:00:00Z" };
  writeFileSync(join(dC, "a.json"), JSON.stringify({ ...base, subject: "FIRST-A" }));
  writeFileSync(join(dC, "b.json"), JSON.stringify({ ...base, subject: "SECOND-B" }));
  const g = buildGraph(buildViewData(dC));
  const n = g.nodes.find((x) => x.id === "receipt:dupX");
  assert.equal(n.subject, "SECOND-B"); // (verifiedAt 동률 → file 코드포인트 큰 쪽) — readdir 순서와 무관하게 결정
  assert.equal(n.occurrences, 2);
  rmSync(dC, { recursive: true, force: true });
});
check("buildGraph: Receipt→Claim→Check 노드/엣지(asserts/checked_by)", () => {
  const d5 = mkdtempSync(join(tmpdir(), "argraph5-"));
  writeFileSync(join(d5, "r.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "idG", subject: "G", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S1", verdict: "failed", checks: { citation: "not-found", number: "verified" } }] }));
  const g = buildGraph(buildViewData(d5));
  assert.deepEqual(g.nodes.map((n) => n.type), ["receipt", "claim", "check", "check"]);
  assert.equal(g.nodes[1].id, "receipt:idG/claim/1");
  assert.deepEqual(g.nodes.filter((n) => n.type === "check").map((n) => n.check).sort(), ["citation", "number"]);
  assert.equal(g.edges.filter((e) => e.type === "asserts").length, 1);
  assert.equal(g.edges.filter((e) => e.type === "checked_by").length, 2);
  rmSync(d5, { recursive: true, force: true });
});
check("buildGraph: reverifies=나중→먼저(reported)·중복 receiptId 접힘(occurrences)·self-edge 0", () => {
  const d6 = mkdtempSync(join(tmpdir(), "argraph6-"));
  const base = { kind: "verification-receipt", surface: "research", verdict: "pass", input: { sha256: "sameSha" } };
  writeFileSync(join(d6, "a.json"), JSON.stringify({ ...base, receiptId: "early", subject: "A", verifiedAt: "2026-07-01T10:00:00Z" }));
  writeFileSync(join(d6, "b.json"), JSON.stringify({ ...base, receiptId: "late", subject: "A", verifiedAt: "2026-07-02T10:00:00Z" }));
  writeFileSync(join(d6, "c.json"), JSON.stringify({ ...base, receiptId: "late", subject: "A", verifiedAt: "2026-07-02T10:00:00Z" })); // 같은 논리적 결과 2파일
  const g = buildGraph(buildViewData(d6));
  assert.equal(g.nodes.filter((n) => n.type === "receipt").length, 2); // late 는 1노드로 접힘
  assert.equal(g.nodes.find((n) => n.id === "receipt:late").occurrences, 2); // 접힌 기록 보존
  const rv = g.edges.filter((e) => e.type === "reverifies");
  assert.equal(rv.length, 1);
  assert.equal(rv[0].from, "receipt:late");
  assert.equal(rv[0].to, "receipt:early");
  assert.equal(rv[0].tier, "reported"); // verifiedAt=자가보고 → verified 로 세탁 금지
  assert.ok(g.edges.every((e) => e.from !== e.to)); // self-edge 없음
  assert.ok(g.edges.every((e) => e.basis && e.tier)); // 모든 엣지에 근거 자기기술 + tier
  rmSync(d6, { recursive: true, force: true });
});
check("buildGraph: verifiedAt 동률 → reverifies 생략(방향 단정 불가)·same_input 유지", () => {
  const d7 = mkdtempSync(join(tmpdir(), "argraph7-"));
  const base = { kind: "verification-receipt", surface: "research", input: { sha256: "tieSha" }, verifiedAt: "2026-07-01T00:00:00Z" };
  writeFileSync(join(d7, "a.json"), JSON.stringify({ ...base, receiptId: "t1", subject: "A", verdict: "pass" }));
  writeFileSync(join(d7, "b.json"), JSON.stringify({ ...base, receiptId: "t2", subject: "A", verdict: "fail" }));
  const g = buildGraph(buildViewData(d7));
  assert.equal(g.edges.filter((e) => e.type === "reverifies").length, 0);
  assert.equal(g.edges.filter((e) => e.type === "same_input").length, 1);
  rmSync(d7, { recursive: true, force: true });
});
check("Evidence Browser: Failure-first 탭(indexes 임베드)·Receipt=맨끝 drill-down", () => {
  const html = buildGraphHtml([]);
  assert.ok(html.includes("Check별 실패") && html.includes("Reason별")); // indexes 탭
  assert.ok(html.includes("Receipt 전체 보기")); // Receipt 는 맨 마지막 drill-down
  assert.ok(html.includes('"indexes"')); // indexes 임베드
  assert.ok(!html.includes("<script src") && !html.includes("<link ")); // 자체완결 불변
  assert.ok(html.includes("&quot;")); // esc 가 따옴표 이스케이프(attribute 주입 차단)
});
check("FailureEvent: file 식별자 포함(결측/중복 receiptId 에도 정확 귀속)", () => {
  const dD = mkdtempSync(join(tmpdir(), "argraphD-"));
  writeFileSync(join(dD, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "x", subject: "P", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found" } }] }));
  const ix = buildIndexes(buildViewData(dD));
  assert.equal(ix.byCheck.citation[0].file, "a.json");
  rmSync(dD, { recursive: true, force: true });
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
