// Evidence Graph 조회레이어 — verification-receipt 디렉터리 로드/필터 + SDK 배럴 export 확인.
// `node test/graph.test.mjs`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReceipts, queryReceipts, buildViewData, buildGraphHtml, buildSummary, buildFailures, buildIndexes, buildGraph, buildFailureEvents, filterFailureEvents, buildGraphDiff, buildHistory, resolveFingerprintPrefix, buildSubjects } from "../dist/graph.js";
import { evaluateClaim, SCHEMA_VERSION, claimFingerprintV1 } from "../dist/index.js"; // SDK 배럴(L7 씨앗)

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
check("L5: HTML 에 지문별 이력 사전계산 임베드 + 1클릭 이력 링크", () => {
  const dL = mkdtempSync(join(tmpdir(), "argraphL-"));
  writeFileSync(join(dL, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "l1", subject: "P", verdict: "fail", surface: "research", input: { sha256: "sL" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "HX", sourceUrl: "http://u", checks: { citation: "not-found" }, verdict: "failed" }] }));
  writeFileSync(join(dL, "b.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "l2", subject: "P", verdict: "pass", surface: "research", input: { sha256: "sL" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "HX", sourceUrl: "http://u", checks: { citation: "verified" }, verdict: "verified" }] }));
  const rows = buildViewData(dL);
  const fp = rows[0].claims[0].fingerprint;
  const html = buildGraphHtml(rows);
  assert.ok(html.includes('"histories"')); // 사전계산 임베드(SSOT=buildHistory)
  assert.ok(html.includes(fp)); // 지문 값 실재
  assert.ok(html.includes("이 주장의 이력 보기")); // 실패 상세 1클릭
  assert.ok(html.includes("첫 등장") && html.includes("data-h=")); // 이력 패널·링크 배선
  // 임베드된 이력이 buildHistory 와 동일(두 진실원 아님)
  const emb = JSON.parse(html.match(/<script id="ar-data"[^>]*>(.*?)<\/script>/s)[1]);
  assert.equal(emb.histories[fp].length, 2);
  assert.equal(emb.histories[fp][1].changes.resolvedFailures.length, 1); // not-found→verified 해소가 화면 데이터에
  rmSync(dL, { recursive: true, force: true });
});
check("FailureEvent: file 식별자 포함(결측/중복 receiptId 에도 정확 귀속)", () => {
  const dD = mkdtempSync(join(tmpdir(), "argraphD-"));
  writeFileSync(join(dD, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "x", subject: "P", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S", verdict: "failed", checks: { citation: "not-found" } }] }));
  const ix = buildIndexes(buildViewData(dD));
  assert.equal(ix.byCheck.citation[0].file, "a.json");
  rmSync(dD, { recursive: true, force: true });
});

// ── Ship B: edge 계약 동결(enum·id·note) ──
check("edge 계약: type/basis/tier enum 동결 + 결정론 id + note", () => {
  const dE = mkdtempSync(join(tmpdir(), "argraphE-"));
  const inp = join(dE, "in.txt");
  writeFileSync(inp, "C");
  const sha = createHash("sha256").update("C").digest("hex");
  writeFileSync(join(dE, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "e1", subject: "S", verdict: "fail", surface: "research", input: { file: inp, sha256: sha }, verifiedAt: "2026-07-01T00:00:00Z", provenance: { reported: { commit: "cc" } }, results: [{ statement: "X", verdict: "failed", checks: { citation: "not-found" } }] }));
  writeFileSync(join(dE, "b.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "e2", subject: "S", verdict: "pass", surface: "research", input: { file: inp, sha256: sha }, verifiedAt: "2026-07-02T00:00:00Z", provenance: { reported: { commit: "cc" } } }));
  const g = buildGraph(buildViewData(dE));
  const TYPES = new Set(["asserts", "checked_by", "same_input", "same_commit", "reverifies"]);
  const BASIS = new Set(["receipt-structure", "input.sha256-rehashed", "input.sha256-stated", "reported.commit", "verifiedAt-order"]);
  for (const e of g.edges) {
    assert.ok(TYPES.has(e.type), `type enum 밖: ${e.type}`);
    assert.ok(BASIS.has(e.basis), `basis enum 밖: ${e.basis}`);
    assert.ok(e.tier === "verified" || e.tier === "reported");
    assert.equal(e.id, `${e.type}:${e.from}=>${e.to}`); // 결정론 id
    assert.ok(typeof e.note === "string" && e.note.length > 0); // 사람 설명
  }
  // 생성규칙 고정: 재해시 일치 → same_input=verified+rehashed basis / reverifies=verifiedAt-order+reported
  const si = g.edges.find((e) => e.type === "same_input");
  assert.equal(si.basis, "input.sha256-rehashed");
  assert.equal(si.tier, "verified");
  const rv = g.edges.find((e) => e.type === "reverifies");
  assert.equal(rv.basis, "verifiedAt-order");
  assert.equal(rv.tier, "reported");
  const sc = g.edges.find((e) => e.type === "same_commit");
  assert.equal(sc.basis, "reported.commit");
  rmSync(dE, { recursive: true, force: true });
});

// ── Ship A: graph failures(triage) — 필터·정렬 ──
check("filterFailureEvents: status/check/sealed/since 필터 + 최신 먼저 정렬", () => {
  const dF = mkdtempSync(join(tmpdir(), "argraphF-"));
  const mk2 = (name, o) => writeFileSync(join(dF, name), JSON.stringify(o));
  mk2("a.json", { kind: "verification-receipt", receiptId: "f1", subject: "P1", verdict: "fail", surface: "research", input: { sha256: "s1" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "A", verdict: "failed", checks: { citation: "not-found" } }] });
  mk2("b.json", { kind: "verification-receipt", receiptId: "f2", subject: "P2", verdict: "fail", surface: "research", input: { sha256: "s2" }, verifiedAt: "2026-07-03T00:00:00Z", results: [{ statement: "B", verdict: "failed", checks: { hash: "mismatch" } }] });
  const events = buildFailureEvents(buildViewData(dF));
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => typeof e.tampered === "boolean" && "verifiedAt" in e && "inputSha" in e && "file" in e));
  assert.equal(filterFailureEvents(events, { status: ["mismatch"] }).length, 1);
  assert.equal(filterFailureEvents(events, { check: "citation" })[0].subject, "P1");
  assert.equal(filterFailureEvents(events, { sealed: true }).length, 0); // 봉인 없음 픽스처 → sealed 로 전부 제외
  assert.equal(filterFailureEvents(events, { since: "2026-07-02T00:00:00Z" }).length, 1); // 자가보고 verifiedAt 기준
  const sorted = filterFailureEvents(events, {});
  assert.equal(sorted[0].check, "hash"); // 최신(7/3) 먼저
  rmSync(dF, { recursive: true, force: true });
});

// ── Ship A: graph diff — 신규/해소/상태변화/입력 verdict 변화 ──
check("buildGraphDiff: 4분면 + 입력 verdict 변화(최신 verifiedAt 기준)", () => {
  const dB1 = mkdtempSync(join(tmpdir(), "argraphG1-"));
  const dB2 = mkdtempSync(join(tmpdir(), "argraphG2-"));
  const mkr = (dir, name, o) => writeFileSync(join(dir, name), JSON.stringify(o));
  // base: 실패 R(citation)·실패 S(hash mismatch)·지속 T(link invalid)·입력 sX=fail
  mkr(dB1, "r.json", { kind: "verification-receipt", receiptId: "bR", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sR" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "Q1", verdict: "failed", checks: { citation: "not-found" } }] });
  mkr(dB1, "s.json", { kind: "verification-receipt", receiptId: "bS", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sS" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "Q2", verdict: "failed", checks: { hash: "mismatch" } }] });
  mkr(dB1, "t.json", { kind: "verification-receipt", receiptId: "bT", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sT" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "Q3", verdict: "failed", checks: { link: "invalid" } }] });
  // head: R 해소(같은 키 실패 없음)·S 상태변화(mismatch→invalid)·T 지속·신규 U(number)·입력 sR=pass 로 변화
  mkr(dB2, "r.json", { kind: "verification-receipt", receiptId: "hR", subject: "W", verdict: "pass", surface: "research", input: { sha256: "sR" }, verifiedAt: "2026-07-02T00:00:00Z" });
  mkr(dB2, "s.json", { kind: "verification-receipt", receiptId: "hS", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sS" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "Q2", verdict: "failed", checks: { hash: "invalid" } }] });
  mkr(dB2, "t.json", { kind: "verification-receipt", receiptId: "hT", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sT" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "Q3", verdict: "failed", checks: { link: "invalid" } }] });
  mkr(dB2, "u.json", { kind: "verification-receipt", receiptId: "hU", subject: "W", verdict: "fail", surface: "research", input: { sha256: "sU" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "Q4", verdict: "failed", checks: { number: "mismatch" } }] });
  const d = buildGraphDiff(buildViewData(dB1), buildViewData(dB2));
  assert.equal(d.newFailures.length, 1);
  assert.equal(d.newFailures[0].check, "number");
  assert.equal(d.resolvedFailures.length, 1);
  assert.equal(d.resolvedFailures[0].check, "citation");
  assert.equal(d.statusChanged.length, 1);
  assert.deepEqual([d.statusChanged[0].baseStatus, d.statusChanged[0].headStatus], ["mismatch", "invalid"]);
  assert.equal(d.persistingCount, 1); // T(link invalid) 지속
  assert.deepEqual(d.inputVerdictChanges, [{ inputSha: "sR", baseVerdict: "fail", headVerdict: "pass" }]);
  assert.ok(d.tamperedBase >= 0 && d.tamperedHead >= 0);
  rmSync(dB1, { recursive: true, force: true });
  rmSync(dB2, { recursive: true, force: true });
});

// ── Ship C: claim fingerprint v1 ──
check("fingerprint: 결정론·cfp1 접두·공백/NFC 정규화·kinds 순서 무관", () => {
  const a = claimFingerprintV1({ statement: "the  sky\n is blue", sourceUrl: "http://s", checkKinds: ["number", "citation"] });
  const b = claimFingerprintV1({ statement: "the sky is blue", sourceUrl: "http://s", checkKinds: ["citation", "number"] });
  assert.equal(a, b); // 공백 정규화 + kinds 정렬
  assert.ok(a.startsWith("cfp1:")); // 버전 자기기술
  const c = claimFingerprintV1({ statement: "the sky is green", sourceUrl: "http://s", checkKinds: ["citation", "number"] });
  assert.notEqual(a, c); // 문구 변경 = 다른 주장(v1 정직 한계)
  const d = claimFingerprintV1({ statement: "the sky is blue", sourceUrl: null, checkKinds: ["citation", "number"] });
  assert.notEqual(a, d); // 출처 다르면 다른 fp
});
check("fingerprint: 영수증 임베드 == graph 폴백 재계산(SSOT 동등성)", () => {
  const dH = mkdtempSync(join(tmpdir(), "argraphH-"));
  const fp = claimFingerprintV1({ statement: "S1", sourceUrl: "http://u", checkKinds: ["citation"] });
  // 임베드된 영수증
  writeFileSync(join(dH, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "hA", subject: "P", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S1", sourceUrl: "http://u", fingerprint: fp, checks: { citation: "not-found" } , verdict: "failed" }] }));
  // 미임베드(구 영수증) — graph 가 같은 함수로 계산해야 동일
  writeFileSync(join(dH, "b.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "hB", subject: "P", verdict: "fail", surface: "research", input: { sha256: "s" }, results: [{ statement: "S1", sourceUrl: "http://u", checks: { citation: "not-found" }, verdict: "failed" }] }));
  const v = buildViewData(dH);
  assert.equal(v[0].claims[0].fingerprint, fp);
  assert.equal(v[1].claims[0].fingerprint, fp); // 폴백 == 임베드
  const g = buildGraph(v);
  assert.ok(g.nodes.filter((n) => n.type === "claim").every((n) => n.fingerprint === fp)); // claim 노드 노출
  const ev = buildFailureEvents(v);
  assert.ok(ev.every((e) => e.fingerprint === fp)); // FailureEvent 노출(triage→history 루프)
  rmSync(dH, { recursive: true, force: true });
});

// ── Ship C: graph history ──
check("buildHistory --claim: 시간축 + 인접 대비 변화(상태변화·해소)", () => {
  const dI = mkdtempSync(join(tmpdir(), "argraphI-"));
  const mk3 = (name, o) => writeFileSync(join(dI, name), JSON.stringify(o));
  const claim = (checks, evd) => ({ statement: "CLAIM X", sourceUrl: "http://u", checks, evidence: evd, verdict: "failed" });
  // t1: citation not-found → t2: 상태 유지·증거 변화 → t3: 해소(verified)
  mk3("t1.json", { kind: "verification-receipt", receiptId: "r1", subject: "P", verdict: "fail", surface: "research", input: { sha256: "sX" }, verifiedAt: "2026-07-01T00:00:00Z", results: [claim({ citation: "not-found" }, { citation: { expected: "q1", actual: "없음" } })] });
  mk3("t2.json", { kind: "verification-receipt", receiptId: "r2", subject: "P", verdict: "fail", surface: "research", input: { sha256: "sX" }, verifiedAt: "2026-07-02T00:00:00Z", results: [claim({ citation: "not-found" }, { citation: { expected: "q2", actual: "없음" } })] });
  mk3("t3.json", { kind: "verification-receipt", receiptId: "r3", subject: "P", verdict: "pass", surface: "research", input: { sha256: "sX" }, verifiedAt: "2026-07-03T00:00:00Z", results: [claim({ citation: "verified" }, undefined)] });
  const rows = buildViewData(dI);
  const fp = rows[0].claims[0].fingerprint;
  const h = buildHistory(rows, { claim: fp });
  assert.equal(h.mode, "claim");
  assert.equal(h.timeline.length, 3);
  assert.equal(h.timeline[0].changes, null); // 첫 항목=기준점
  assert.deepEqual(h.timeline[1].changes.evidenceChanged.length, 1); // 같은 상태·증거만 변화
  assert.equal(h.timeline[2].changes.resolvedFailures.length, 1); // not-found → verified = 해소
  assert.equal(h.timeline[2].verdict, "pass");
  // prefix 해석: 유일 접두 → fp·빈 접두(전부 같은 fp)도 유일
  assert.equal(resolveFingerprintPrefix(rows, fp.slice(0, 12)).fp, fp);
  assert.equal(resolveFingerprintPrefix(rows, "cfp9:").fp, null); // 없음
  rmSync(dI, { recursive: true, force: true });
});
check("buildHistory --input: 입력 기준 타임라인 + 새 실패 감지", () => {
  const dJ = mkdtempSync(join(tmpdir(), "argraphJ-"));
  const mk4 = (name, o) => writeFileSync(join(dJ, name), JSON.stringify(o));
  mk4("a.json", { kind: "verification-receipt", receiptId: "i1", subject: "P", verdict: "pass", surface: "research", input: { sha256: "sIN" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "A", checks: { citation: "verified" }, verdict: "verified" }] });
  mk4("b.json", { kind: "verification-receipt", receiptId: "i2", subject: "P", verdict: "fail", surface: "research", input: { sha256: "sIN" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "A", checks: { citation: "not-found" }, verdict: "failed" }] });
  const h = buildHistory(buildViewData(dJ), { input: "sIN" });
  assert.equal(h.mode, "input");
  assert.equal(h.timeline.length, 2);
  assert.equal(h.timeline[1].changes.newFailures.length, 1); // verified → not-found = 새 실패
  rmSync(dJ, { recursive: true, force: true });
});

// ── Ship C: diff --match fingerprint ──
check("buildGraphDiff --match fingerprint: 모드 자기기술 + fp 기준 매칭", () => {
  const dK1 = mkdtempSync(join(tmpdir(), "argraphK1-"));
  const dK2 = mkdtempSync(join(tmpdir(), "argraphK2-"));
  // 같은 fp(같은 statement·출처·kinds)가 다른 subject 로 나타나도 fp 모드에선 같은 키
  writeFileSync(join(dK1, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "k1", subject: "SUBJ-1", verdict: "fail", surface: "research", input: { sha256: "s1" }, results: [{ statement: "SAME", sourceUrl: "http://u", checks: { citation: "not-found" }, verdict: "failed" }] }));
  writeFileSync(join(dK2, "a.json"), JSON.stringify({ kind: "verification-receipt", receiptId: "k2", subject: "SUBJ-2", verdict: "fail", surface: "research", input: { sha256: "s2" }, results: [{ statement: "SAME", sourceUrl: "http://u", checks: { citation: "not-found" }, verdict: "failed" }] }));
  const base = buildViewData(dK1), head = buildViewData(dK2);
  const dStmt = buildGraphDiff(base, head, {});
  assert.equal(dStmt.match, "statement");
  assert.equal(dStmt.newFailures.length, 1); // statement 모드: 입력sha 다름 → 다른 키(신규+해소)
  const dFp = buildGraphDiff(base, head, { match: "fingerprint" });
  assert.equal(dFp.match, "fingerprint");
  assert.equal(dFp.newFailures.length, 0); // fp 모드: 같은 주장 → 지속
  assert.equal(dFp.persistingCount, 1);
  rmSync(dK1, { recursive: true, force: true });
  rmSync(dK2, { recursive: true, force: true });
});

// ── L6: subject 상태판(buildSubjects·history --subject·diff bySubject) ──
check("buildSubjects: subject 별 순수 롤업(카운트만)", () => {
  const dM = mkdtempSync(join(tmpdir(), "argraphM-"));
  const mk5 = (name, o) => writeFileSync(join(dM, name), JSON.stringify(o));
  mk5("a.json", { kind: "verification-receipt", receiptId: "m1", subject: "ProjA", verdict: "fail", surface: "research", input: { sha256: "s1" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "A", checks: { citation: "not-found", hash: "mismatch" }, verdict: "failed" }] });
  mk5("b.json", { kind: "verification-receipt", receiptId: "m2", subject: "ProjA", verdict: "pass", surface: "research", input: { sha256: "s2" }, verifiedAt: "2026-07-02T00:00:00Z" });
  mk5("c.json", { kind: "verification-receipt", receiptId: "m3", subject: "ProjB", verdict: "pass", surface: "council", input: { sha256: "s3" } });
  const subs = buildSubjects(buildViewData(dM));
  assert.equal(subs.length, 2);
  assert.equal(subs[0].subject, "ProjA"); // 실패 많은 순
  assert.deepEqual([subs[0].receipts, subs[0].pass, subs[0].fail, subs[0].failureEvents], [2, 1, 1, 2]);
  assert.deepEqual(subs[0].byCheck, { citation: 1, hash: 1 });
  assert.equal(subs[0].firstVerifiedAt, "2026-07-01T00:00:00Z");
  assert.equal(subs[0].lastVerifiedAt, "2026-07-02T00:00:00Z");
  assert.equal(subs[1].failureEvents, 0);
  rmSync(dM, { recursive: true, force: true });
});
check("buildHistory --subject: 주제 단위 타임라인", () => {
  const dN = mkdtempSync(join(tmpdir(), "argraphN-"));
  const mk6 = (name, o) => writeFileSync(join(dN, name), JSON.stringify(o));
  mk6("a.json", { kind: "verification-receipt", receiptId: "n1", subject: "ProjX", verdict: "fail", surface: "research", input: { sha256: "sA" }, verifiedAt: "2026-07-01T00:00:00Z", results: [{ statement: "Q", checks: { citation: "not-found" }, verdict: "failed" }] });
  mk6("b.json", { kind: "verification-receipt", receiptId: "n2", subject: "ProjX", verdict: "pass", surface: "research", input: { sha256: "sB" }, verifiedAt: "2026-07-02T00:00:00Z", results: [{ statement: "Q", checks: { citation: "verified" }, verdict: "verified" }] });
  mk6("z.json", { kind: "verification-receipt", receiptId: "n3", subject: "다른것", verdict: "fail", surface: "research", input: { sha256: "sC" } });
  const h = buildHistory(buildViewData(dN), { subject: "ProjX" });
  assert.equal(h.mode, "subject");
  assert.equal(h.timeline.length, 2); // 다른 subject 제외
  assert.equal(h.timeline[1].changes.resolvedFailures.length, 1); // 해소 감지(입력 달라도 지문 동일 키)
  rmSync(dN, { recursive: true, force: true });
});
check("buildGraphDiff: bySubject 롤업(subject 단위 변화량)", () => {
  const dO1 = mkdtempSync(join(tmpdir(), "argraphO1-"));
  const dO2 = mkdtempSync(join(tmpdir(), "argraphO2-"));
  const mk7 = (dir, name, o) => writeFileSync(join(dir, name), JSON.stringify(o));
  mk7(dO1, "a.json", { kind: "verification-receipt", receiptId: "o1", subject: "P1", verdict: "fail", surface: "research", input: { sha256: "sP" }, results: [{ statement: "K", checks: { citation: "not-found" }, verdict: "failed" }] });
  mk7(dO2, "a.json", { kind: "verification-receipt", receiptId: "o2", subject: "P1", verdict: "fail", surface: "research", input: { sha256: "sP" }, results: [{ statement: "K", checks: { citation: "not-found" }, verdict: "failed" }] });
  mk7(dO2, "b.json", { kind: "verification-receipt", receiptId: "o3", subject: "P2", verdict: "fail", surface: "research", input: { sha256: "sQ" }, results: [{ statement: "L", checks: { number: "mismatch" }, verdict: "failed" }] });
  const d = buildGraphDiff(buildViewData(dO1), buildViewData(dO2));
  assert.deepEqual(d.bySubject.P1, { new: 0, resolved: 0, statusChanged: 0, persisting: 1 }); // 지속
  assert.deepEqual(d.bySubject.P2, { new: 1, resolved: 0, statusChanged: 0, persisting: 0 }); // 신규
  rmSync(dO1, { recursive: true, force: true });
  rmSync(dO2, { recursive: true, force: true });
});
check("HTML: Subjects(상태판) 탭 + subjects 임베드", () => {
  const html = buildGraphHtml([]);
  assert.ok(html.includes("Subjects(상태판)"));
  assert.ok(html.includes('"subjects"'));
  assert.ok(html.includes("subject 상태판 — 카운트 롤업(판단 아님)"));
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
