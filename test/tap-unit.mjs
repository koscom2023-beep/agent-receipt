// mcp-tap 순수 코어 단위테스트 — 스펙 v0.3 §5/§6/§8 + 불변식 I3(메모리→디스크 경계)/I4(결정론)/I9(닫힘 결정론).
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argShape, summarizeUri, sqlLeadKind, classifyCall,
  Coalescer, isCoalescible, createFrameSplitter, createTapSession,
  TapLog, tapEntryHash, verifyTapFile,
} from "../dist/tap.js";

// ── argShape: 키만·digest만·부재는 null·비유한수 canonFailed ──
{
  const s = argShape({ query: "SELECT 1", password: "S3CRET_CANARY" }, "raw");
  assert.deepEqual(s.argKeys, ["query", "password"], "키 이름만");
  assert.ok(String(s.argsDigest).startsWith("sha256:"), "digest 존재");
  assert.ok(!JSON.stringify(s).includes("S3CRET_CANARY"), "값 미저장(I3)");
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["k" + i, i]));
  assert.equal(argShape(many, "raw").argKeys.length, 32, "argKeys 상한 32");
  assert.equal(argShape(undefined, "raw").argsDigest, null, "인자 부재=null(빈 객체 위조 금지)");
  const inf = JSON.parse('{"x":1e999}'); // Infinity → JCS 거부 → canonFailed 폴백(결정 6)
  const f = argShape(inf, '{"x":1e999}');
  assert.equal(f.canonFailed, true, "canonFailed 라벨");
  assert.ok(String(f.frameDigest).startsWith("sha256:"), "원시 frameDigest 대체");
  assert.equal(f.argsDigest, null, "실패 시 digest 없음");
}

// ── summarizeUri: 스킴 이원화 + userinfo 전면 제거 + uriDigest 병기 ──
{
  const f = summarizeUri("file:///home/u/a.txt");
  assert.equal(f.uri, "file:///home/u/a.txt", "file 스킴=경로 저장");
  assert.ok(String(f.uriDigest).startsWith("sha256:"));
  const h = summarizeUri("https://user:pw123@api.example.com:8443/secret/path?token=abc");
  assert.equal(h.scheme, "https");
  assert.equal(h.host, "api.example.com:8443", "host 만(포트 포함)");
  const ser = JSON.stringify(h);
  assert.ok(!ser.includes("pw123") && !ser.includes("secret/path") && !ser.includes("token"), "userinfo·경로·쿼리 미저장");
  const p = summarizeUri("postgres://admin:dbpw@db.internal:5432/prod");
  assert.equal(p.scheme, "postgres");
  assert.ok(!JSON.stringify(p).includes("dbpw"), "비HTTP 스킴도 userinfo 제거");
  const bad = summarizeUri("::::");
  assert.equal(bad.scheme, "unparsed");
  assert.ok(String(bad.uriDigest).startsWith("sha256:"), "파싱 불가여도 digest 는 남김");
}

// ── sqlLeadKind: 0.20 lead-token 규율 ──
assert.equal(sqlLeadKind("  SELECT * FROM t"), "read");
assert.equal(sqlLeadKind("insert into t values(1)"), "write");
assert.equal(sqlLeadKind("'INSERT' 라는 문자열"), "other", "따옴표 시작=판단 안 함");
assert.equal(sqlLeadKind("WITH x AS (SELECT 1) DELETE FROM t"), "other", "모호 선두=중립");

// ── classifyCall ──
assert.deepEqual(classifyCall("fs", "run_command", {}), ["exec"]);
assert.deepEqual(classifyCall("supabase", "execute_sql", { query: "INSERT INTO a VALUES(1)" }), ["db-write"]);
assert.deepEqual(classifyCall("supabase", "execute_sql", { query: "SELECT 1" }), ["db-read"]);
assert.deepEqual(classifyCall("supabase", "delete_row", {}), ["db-write"], "db 서버 힌트+쓰기 렉시콘");
assert.deepEqual(classifyCall("fs", "read_file", { path: "a" }), ["fs-read"]);
assert.deepEqual(classifyCall("fs", "write_file", { path: "a" }), ["fs-write"]);
assert.deepEqual(classifyCall("ops", "deploy_site", {}), ["deploy"]);
assert.deepEqual(classifyCall("web", "fetch_url", {}), ["network"]);
assert.deepEqual(classifyCall("x", "mystery", {}), ["unknown"]);

// ── Coalescer: 무손실 병합 · 닫힘 3조건(I9: 시간 조건 없음) ──
{
  const mk = (seq, extra = {}) => ({
    schemaVersion: "tap/1", kind: "call", seq, ts: "T" + seq, server: "s",
    rpc: { id: String(seq), method: "tools/call" },
    tool: { name: "list_files", argsDigest: "sha256:aaa", argKeys: ["p"], argBytes: 9 },
    result: { status: "ok", isError: false, resultDigest: "sha256:bbb", resultBytes: 3, latencyMs: seq }, // 지연은 매번 다름
    class: ["fs-read"], ...extra,
  });
  const co = new Coalescer(1000);
  let out = [];
  for (let i = 0; i < 37; i++) out.push(...co.push(mk(i)));
  assert.equal(out.length, 0, "동일 연속 읽기는 열린 창에 누적");
  out.push(...co.push(mk(37, { result: { status: "ok", isError: false, resultDigest: "sha256:CHANGED", resultBytes: 3 } })));
  assert.equal(out.length, 1, "결과가 달라지면 창이 닫힘(무손실)");
  assert.equal(out[0].repeat, 37);
  assert.equal(out[0].firstSeq, 0);
  assert.equal(out[0].lastSeq, 36);
  assert.equal(out[0].firstTs, "T0");
  assert.equal(out[0].lastTs, "T36");
  assert.equal(out[0].result.latencyMs, undefined, "병합 창은 지연 미기록(대표값 위조 금지)");
  const tail = co.flush();
  assert.equal(tail.length, 1, "스트림 종료 flush");
  assert.equal(tail[0].repeat, undefined, "단건은 원형 그대로");

  // 쓰기류는 절대 병합 안 함
  const co2 = new Coalescer(1000);
  const w = (seq) => ({ schemaVersion: "tap/1", kind: "call", seq, ts: "T", server: "s", rpc: { id: String(seq), method: "tools/call" }, tool: { name: "execute_sql", argsDigest: "sha256:same" }, result: { status: "ok" }, class: ["db-write"] });
  assert.equal(isCoalescible(w(1)), false, "db-write 병합 불가");
  const outs = [...co2.push(w(1)), ...co2.push(w(2)), ...co2.push(w(3)), ...co2.flush()];
  assert.equal(outs.length, 3, "동일 INSERT 3번=3레코드");

  // repeat 상한=개수 기반 분절(결정론)
  const co3 = new Coalescer(3);
  const seg = [];
  for (let i = 0; i < 7; i++) seg.push(...co3.push(mk(i)));
  seg.push(...co3.flush());
  assert.deepEqual(seg.map((r) => r.repeat ?? 1), [3, 3, 1], "상한 3 → 3+3+1 분절");

  // notification 병합(동일 method 연속)
  const co4 = new Coalescer(1000);
  const n = (seq) => ({ schemaVersion: "tap/1", kind: "notification", seq, ts: "T" + seq, server: "s", method: "notifications/progress", dir: "s2c" });
  const outs4 = [...co4.push(n(1)), ...co4.push(n(2)), ...co4.push(n(3)), ...co4.flush()];
  assert.equal(outs4.length, 1);
  assert.equal(outs4[0].repeat, 3, "진행률 스팸 병합");
}

// ── frame 분할기: 부분 프레임·상한 초과 opaque(스트리밍 해시) ──
{
  const sp = createFrameSplitter(64);
  let evs = sp.feed(Buffer.from('{"a":1}\n{"b"'));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].line, '{"a":1}');
  evs = sp.feed(Buffer.from(':2}\n'));
  assert.equal(evs[0].line, '{"b":2}', "부분 프레임 이어붙임");
  evs = sp.feed(Buffer.from("X".repeat(100))); // 상한 64 초과 → skipping
  assert.equal(evs.length, 0);
  evs = sp.feed(Buffer.from("YY\n"));
  assert.ok(evs[0].opaque, "초과분은 opaque");
  assert.equal(evs[0].opaque.bytes, 102);
  evs = sp.feed(Buffer.from('{"c":3}\n'));
  assert.equal(evs[0].line, '{"c":3}', "skipping 해제 후 정상 복귀");
}

// ── TapLog + 체인 + verify: 변조·삭제 탐지, 파일 이어받기 ──
{
  const dir = mkdtempSync(join(tmpdir(), "tapchain-"));
  const log = new TapLog(dir, "s-1.jsonl");
  for (let i = 0; i < 3; i++) log.append({ schemaVersion: "tap/1", kind: "rpc", seq: log.nextSeq(), ts: "T", method: "m" + i });
  await log.drain();
  const clean = verifyTapFile(join(dir, "s-1.jsonl"));
  assert.equal(clean.records, 3);
  assert.equal(clean.tampered + clean.chainBreaks + clean.seqGaps + clean.coalesceErrors, 0, "클린 체인");

  // 이어받기: 같은 파일에 새 TapLog(재부팅 모사) → 체인 연속
  const log2 = new TapLog(dir, "s-1.jsonl");
  log2.append({ schemaVersion: "tap/1", kind: "rpc", seq: log2.nextSeq(), ts: "T", method: "m3" });
  await log2.drain();
  const cont = verifyTapFile(join(dir, "s-1.jsonl"));
  assert.equal(cont.records, 4);
  assert.equal(cont.chainBreaks, 0, "재부팅 후 체인 이어받기(§5.1)");
  assert.equal(cont.seqGaps, 0);

  // 변조: 중간 레코드 값 1글자 수정 → tampered
  const f = join(dir, "s-1.jsonl");
  const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
  const rec = JSON.parse(lines[1]);
  rec.method = "EVIL";
  lines[1] = JSON.stringify(rec);
  writeFileSync(f, lines.join("\n") + "\n");
  const bad = verifyTapFile(f);
  assert.ok(bad.tampered >= 1, "변조 탐지");
  // 삭제: 한 줄 제거 → prevHash 불연속
  writeFileSync(f, [lines[0], lines[2], lines[3]].join("\n") + "\n");
  const del = verifyTapFile(f);
  assert.ok(del.chainBreaks >= 1 || del.seqGaps >= 1, "삭제 탐지");
}

// ── 세션 통합(순수·시계 주입): I4 결정론 + I3 카나리아 + 페어링·고아·퇴출 ──
{
  const frames = [];
  const req = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  const resp = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  const c2s = [
    req(1, "initialize", { protocolVersion: "2026-01-01" }),
    req(2, "tools/list", {}),
    req(3, "tools/call", { name: "list_files", arguments: { path: "/a" } }),
    req(4, "tools/call", { name: "list_files", arguments: { path: "/a" } }),
    req(5, "tools/call", { name: "execute_sql", arguments: { query: "INSERT INTO t VALUES('S3CRET_CANARY')" } }),
    "GARBAGE-NOT-JSON\n",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    req(10, "ping", {}), // 미추적 method — 응답이 orphan 으로 오탐되면 안 됨
  ].join("");
  const s2c = [
    resp(1, { protocolVersion: "2026-01-01", serverInfo: { name: "fake" } }),
    resp(2, { tools: [{ name: "b_tool" }, { name: "a_tool" }] }),
    resp(3, { content: [{ type: "text", text: "same" }] }),
    resp(4, { content: [{ type: "text", text: "same" }] }),
    resp(5, { content: [], isError: false }),
    resp(10, { pong: true }), // 미추적 요청의 응답 → 무기록(요청은 rpc 로 이미 기록)
    resp(99, { orphan: true }),
  ].join("");

  const run = () => {
    const recs = [];
    let seq = -1;
    const s = createTapSession({
      serverName: "supabase",
      sink: (r) => recs.push(r),
      nextSeq: () => ++seq,
      now: () => "TS",
      nowMs: () => 1000, // 시계 고정 → latency 0 · TTL 미발동
    });
    // 요청→응답 순서 인터리브(페어링이 순서 무관임은 id 로 보장)
    s.clientData(Buffer.from(c2s));
    s.serverData(Buffer.from(s2c));
    s.end();
    return recs;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, "I4: 같은 입력 → 동일 레코드 열(시계 주입 시 완전 동일)");

  const ser = JSON.stringify(a);
  assert.ok(!ser.includes("S3CRET_CANARY"), "I3: 인자 값이 레코드 어디에도 없음");
  assert.ok(!ser.includes("/a"), "경로 값도 argsDigest 뒤로 숨음(tools/call 인자)");

  const kinds = a.map((r) => r.kind + (r.repeat ? ":" + r.repeat : ""));
  // notification·garbage 는 c2s 처리 시점에 나오고, call 들은 응답 도착 시 생성된다.
  assert.ok(kinds.includes("opaque"), "쓰레기 프레임=opaque");
  assert.ok(kinds.includes("notification"), "알림 기록");
  assert.ok(kinds.includes("serverInfo"), "initialize 응답=serverInfo");
  assert.ok(kinds.includes("toolSurface"), "tools/list 응답=표면 스냅샷");
  const surface = a.find((r) => r.kind === "toolSurface");
  assert.equal(surface.count, 2);
  assert.ok(!JSON.stringify(surface).includes("a_tool"), "이름 목록 미저장(digest 만)");
  const merged = a.find((r) => r.kind === "call" && r.repeat === 2);
  assert.ok(merged, "동일 read 2연속 병합");
  assert.equal(merged.tool.name, "list_files");
  const sql = a.find((r) => r.kind === "call" && r.tool?.name === "execute_sql");
  assert.deepEqual(sql.class, ["db-write"], "INSERT 선두 토큰=db-write");
  const orphans = a.filter((r) => r.result?.status === "orphan");
  assert.equal(orphans.length, 1, "진짜 짝 없는 응답만 orphan(미추적 ping 응답은 제외)");
  assert.equal(orphans[0].rpc.id, "99");
  assert.ok(a.some((r) => r.kind === "rpc" && r.method === "ping"), "미추적 요청은 rpc(method 만)로 기록");

  // 페어링 상한: cap=2 → 3번째 요청 삽입 시 최고령 퇴출(unpaired·cap)
  const recs2 = [];
  let seq2 = -1;
  const s2 = createTapSession({ serverName: "x", sink: (r) => recs2.push(r), nextSeq: () => ++seq2, now: () => "TS", nowMs: () => 0, pendingCap: 2 });
  s2.clientData(Buffer.from(req(1, "tools/call", { name: "read_file", arguments: { path: "1" } })));
  s2.clientData(Buffer.from(req(2, "tools/call", { name: "read_file", arguments: { path: "2" } })));
  s2.clientData(Buffer.from(req(3, "tools/call", { name: "read_file", arguments: { path: "3" } })));
  s2.end();
  const evicted = recs2.find((r) => Array.isArray(r.markers) && r.markers.includes("unpaired") && r.markers.includes("cap"));
  assert.ok(evicted, "상한 초과=자백형 퇴출(unpaired·cap)");
  assert.equal(evicted.rpc.id, "1", "최고령부터");

  // TTL: 시계 주입으로 5분 경과 모사
  const recs3 = [];
  let seq3 = -1;
  let clock = 0;
  const s3 = createTapSession({ serverName: "x", sink: (r) => recs3.push(r), nextSeq: () => ++seq3, now: () => "TS", nowMs: () => clock, ttlMs: 100 });
  s3.clientData(Buffer.from(req(1, "tools/call", { name: "read_file", arguments: { path: "1" } })));
  clock = 500;
  s3.clientData(Buffer.from(req(2, "tools/call", { name: "read_file", arguments: { path: "2" } })));
  s3.end();
  const ttl = recs3.find((r) => Array.isArray(r.markers) && r.markers.includes("ttl"));
  assert.ok(ttl, "TTL 만료=자백형 퇴출");
}

// ── entryHash 결정론(직렬화=JCS) ──
{
  const r1 = { b: 1, a: 2, kind: "rpc" };
  const r2 = { kind: "rpc", a: 2, b: 1 };
  assert.equal(tapEntryHash(r1), tapEntryHash(r2), "키 순서 무관(JCS 정규화)");
}

console.log("tap-unit: OK (형태·URI·분류·병합·체인·세션 결정론·카나리아)");
