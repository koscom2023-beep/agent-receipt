import { createHash, randomBytes } from "node:crypto";
import { appendFile, appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { jcsCanonicalize, jcsDigest, JCS_DIGEST_ALG } from "./jcs.js";
import { installedVersion } from "./version.js";

// ── mcp-tap: 에이전트와 MCP 서버 사이의 "관측 전용" stdio 프록시 (docs/MCP_TAP_SPEC.md v0.3) ──
// 원칙: 게이트웨이 아님 · 차단 안 함 · 기록 실패는 스트림을 못 막음(fail-open) ·
//       값 미저장(형태·크기·digest 만) · env 미기록 · 판정(verdict) 입력 아님.
// 이 파일은 스펙 §5~§8 의 순수 코어(분리 export·테스트 대상)와 §7 런타임(runMcpTap)을 담는다.
// CLI 표면(tap install/status/... )은 별도 시공 단계.

export const TAP_SCHEMA = "tap/1";
export type TapRec = Record<string, unknown>;

// ────────────────────────────────────────── 해시 유틸 ──

export function sha256Of(data: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

/** capture 체인 규약 동형: entryHash = 자신(entryHash 제외)의 결정론 직렬화 sha256. 직렬화는 JCS. */
export function tapEntryHash(r: TapRec): string {
  const o: TapRec = {};
  for (const k of Object.keys(r)) if (k !== "entryHash") o[k] = r[k];
  return "sha256:" + createHash("sha256").update(jcsCanonicalize(o), "utf8").digest("hex");
}

// ────────────────────────────────────────── frame 분할기 (§6.1) ──
// 개행 구분 JSON. 부분 frame 버퍼링 · 상한 초과 시 스트리밍 해시로 opaque 처리(중계는 별도 배선이라 무영향).

export type FrameEvent = { line?: string; opaque?: { bytes: number; frameDigest: string } };

export function createFrameSplitter(maxBuf = 8 * 1024 * 1024): { feed(chunk: Buffer): FrameEvent[] } {
  let buf: Buffer = Buffer.alloc(0);
  let skipping = false;
  let skipHash: ReturnType<typeof createHash> | null = null;
  let skipBytes = 0;
  return {
    feed(chunk: Buffer): FrameEvent[] {
      const out: FrameEvent[] = [];
      let data: Buffer = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      buf = Buffer.alloc(0);
      for (;;) {
        const nl = data.indexOf(0x0a);
        if (skipping) {
          if (nl === -1) {
            skipHash!.update(data);
            skipBytes += data.length;
            return out;
          }
          skipHash!.update(data.subarray(0, nl));
          skipBytes += nl;
          out.push({ opaque: { bytes: skipBytes, frameDigest: "sha256:" + skipHash!.digest("hex") } });
          skipping = false;
          skipHash = null;
          skipBytes = 0;
          data = data.subarray(nl + 1);
          continue;
        }
        if (nl === -1) {
          if (data.length > maxBuf) {
            skipping = true;
            skipHash = createHash("sha256");
            skipHash.update(data);
            skipBytes = data.length;
            return out;
          }
          buf = data;
          return out;
        }
        const line = data.subarray(0, nl).toString("utf8");
        if (line.trim().length) out.push({ line });
        data = data.subarray(nl + 1);
      }
    },
  };
}

// ────────────────────────────────────────── 인자 형태 (§5.2) ──

export type ArgShape = {
  argKeys?: string[];
  argsDigest: string | null;
  argBytes?: number;
  canonFailed?: true;
  frameDigest?: string;
};

/** 값 미저장: 최상위 키 이름(최대 32)·크기·JCS digest 만. 부재는 null(빈 객체로 위조 금지). 원문은 호출부에서 즉시 폐기. */
export function argShape(args: unknown, rawLine: string): ArgShape {
  if (args === undefined) return { argsDigest: null };
  const shape: ArgShape = { argsDigest: null };
  if (args && typeof args === "object" && !Array.isArray(args)) {
    shape.argKeys = Object.keys(args as object).slice(0, 32);
  }
  try {
    shape.argBytes = Buffer.byteLength(JSON.stringify(args) ?? "", "utf8");
  } catch {
    /* 파스 산물엔 순환 없음 — 방어만 */
  }
  try {
    shape.argsDigest = jcsDigest(args);
  } catch {
    // 결정 6: canonicalize 실패(비유한수 등)면 digest 대신 원시 프레임 digest + 정직 라벨.
    shape.canonFailed = true;
    shape.frameDigest = sha256Of(rawLine);
  }
  return shape;
}

// ────────────────────────────────────────── URI 이원화 (§6.5) ──

/** file 스킴=경로(메타데이터) · 그 외=scheme+host(userinfo 전면 제거·경로/쿼리 미저장) · 항상 uriDigest 병기. */
export function summarizeUri(uri: string): TapRec {
  const out: TapRec = { uriDigest: sha256Of(uri) };
  try {
    const u = new URL(uri);
    if (u.protocol === "file:") {
      out.uri = "file://" + u.pathname; // URL 파서가 userinfo 를 경로에 안 섞음 · 경로=capture "경로=메타데이터" 선례
    } else {
      out.scheme = u.protocol.replace(/:$/, "");
      if (u.hostname) out.host = u.hostname + (u.port ? ":" + u.port : ""); // hostname 은 userinfo 불포함
    }
  } catch {
    out.scheme = "unparsed"; // 원문은 저장하지 않는다 — digest 만
  }
  return out;
}

// ────────────────────────────────────────── 행위 분류 (§8 · advisory) ──

export function sqlLeadKind(text: string): "read" | "write" | "other" {
  const t = text.replace(/^\s+/, "");
  if (!t) return "other";
  const c0 = t[0];
  if (c0 === "'" || c0 === '"' || c0 === "`") return "other"; // 0.20 lead-token 규율: 따옴표 시작은 판단하지 않는다
  const m = /^([A-Za-z]+)/.exec(t);
  if (!m) return "other";
  const w = m[1].toUpperCase();
  if (["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "VALUES", "PRAGMA"].includes(w)) return "read";
  if (["INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "MERGE", "REPLACE"].includes(w)) return "write";
  return "other"; // WITH 등 모호 선두는 중립(unknown) — 허위 신호보다 무신호
}

const RE_EXEC = /(^|[_-])(run|exec|execute|bash|shell|command|spawn)([_-]|$)/i;
const RE_DEPLOY = /deploy|rollout/i;
const RE_PUBLISH = /publish/i;
const RE_NET = /fetch|http|url|web[_-]?search|search[_-]?web|browse|curl|download/i;
const RE_FSW = /write|edit|patch|apply|save|mkdir|move|rename|copy|delete|remove|unlink/i;
const RE_FSR = /read|cat|view|stat|glob|grep|list|search|get([_-]|$)/i;
const RE_DBHINT = /sql|query|db|database|postgres|supabase|mysql|sqlite/i;

/** 도구명 렉시콘 + db 는 선두 토큰(값을 메모리에서 잠깐 봄 · digest 와 동일 수명 · 디스크 미저장). 판정 입력 아님. */
export function classifyCall(serverName: string, toolName: string, args: unknown): string[] {
  const n = toolName;
  const dbish = RE_DBHINT.test(serverName) || RE_DBHINT.test(n);
  // 1) 실제 SQL 텍스트의 선두 토큰이 가장 구체적 증거 — 도구명 렉시콘(execute_ 등)보다 우선.
  if (dbish && args && typeof args === "object" && !Array.isArray(args)) {
    for (const key of ["query", "sql", "statement", "command"]) {
      const v = (args as Record<string, unknown>)[key];
      if (typeof v === "string") {
        const k = sqlLeadKind(v);
        if (k === "read") return ["db-read"];
        if (k === "write") return ["db-write"];
        return ["unknown"];
      }
    }
  }
  if (RE_EXEC.test(n)) return ["exec"];
  if (RE_DEPLOY.test(n)) return ["deploy"];
  if (RE_PUBLISH.test(n)) return ["publish"];
  if (dbish) {
    if (RE_FSW.test(n)) return ["db-write"];
    if (RE_FSR.test(n)) return ["db-read"];
    return ["unknown"];
  }
  if (RE_NET.test(n)) return ["network"];
  if (RE_FSW.test(n)) return ["fs-write"];
  if (RE_FSR.test(n)) return ["fs-read"];
  return ["unknown"];
}

// ────────────────────────────────────────── 병합(coalescing · §5.5) ──
// 샘플링 금지의 대안(무손실 압축). 닫힘은 입력-사건 3개뿐: 다른 레코드 도착 · 스트림 종료 · repeat 상한.
// 시간 기반 닫힘 금지(I9 · 결정론 보호). 쓰기·실행·네트워크·배포류는 절대 병합 안 함.

const NEVER_COALESCE = new Set(["fs-write", "db-write", "exec", "network", "deploy", "publish"]);

export function isCoalescible(rec: TapRec): boolean {
  if (rec.kind === "notification") return true;
  if (rec.kind !== "call") return false;
  if (rec.markers) return false; // unpaired 등 마커 달린 레코드는 개별 보존
  const cls = (rec.class as string[]) ?? [];
  if (cls.some((c) => NEVER_COALESCE.has(c))) return false;
  const method = (rec.rpc as { method?: string } | undefined)?.method;
  if (method === "resources/read" || method === "prompts/get") return true;
  if (cls.includes("fs-read") || cls.includes("db-read")) return true;
  const name = String((rec.tool as { name?: unknown } | undefined)?.name ?? "");
  return /(^|[_-])list/i.test(name);
}

/** 동일성 키: 의미 필드 전부(지연시간 제외 — 측정치라 매 호출 변동). */
export function coalesceKey(rec: TapRec): string {
  const result = rec.result && typeof rec.result === "object" ? { ...(rec.result as TapRec) } : rec.result;
  if (result && typeof result === "object") delete (result as TapRec).latencyMs;
  return jcsCanonicalize({
    kind: rec.kind ?? null,
    dir: rec.dir ?? null,
    server: rec.server ?? null,
    method: (rec.rpc as { method?: string } | undefined)?.method ?? rec.method ?? null,
    tool: rec.tool ?? null,
    result: result ?? null,
    class: rec.class ?? null,
    uri: rec.uri ?? null,
    scheme: rec.scheme ?? null,
    host: rec.host ?? null,
    uriDigest: rec.uriDigest ?? null,
  });
}

export class Coalescer {
  private open: { rec: TapRec; key: string; repeat: number; firstSeq: number; lastSeq: number; firstTs: string; lastTs: string } | null = null;
  constructor(private cap = 1000) {}

  push(rec: TapRec): TapRec[] {
    const out: TapRec[] = [];
    if (!isCoalescible(rec)) {
      out.push(...this.flush());
      out.push(rec);
      return out;
    }
    const key = coalesceKey(rec);
    if (this.open && this.open.key === key) {
      this.open.repeat += 1;
      this.open.lastSeq = rec.seq as number;
      this.open.lastTs = rec.ts as string;
      if (this.open.repeat >= this.cap) out.push(...this.flush()); // 개수 기반 분절=입력-결정론(I9)
      return out;
    }
    out.push(...this.flush());
    this.open = { rec, key, repeat: 1, firstSeq: rec.seq as number, lastSeq: rec.seq as number, firstTs: rec.ts as string, lastTs: rec.ts as string };
    return out;
  }

  /** 스트림 종료·비병합 레코드 도착 시 호출. 크래시로 열린 창이 유실될 수 있음은 스펙 §11(e)에 정직 기재. */
  flush(): TapRec[] {
    if (!this.open) return [];
    const o = this.open;
    this.open = null;
    if (o.repeat === 1) return [o.rec];
    const merged: TapRec = { ...o.rec, repeat: o.repeat, firstSeq: o.firstSeq, lastSeq: o.lastSeq, firstTs: o.firstTs, lastTs: o.lastTs };
    delete merged.seq;
    delete merged.ts;
    if (merged.result && typeof merged.result === "object") {
      const r = { ...(merged.result as TapRec) };
      delete r.latencyMs; // 병합 창은 지연 미기록(개별 측정치를 대표값으로 위조하지 않는다)
      merged.result = r;
    }
    return [merged];
  }
}

// ────────────────────────────────────────── 로그(체인 append · §5.0/§5.4/§7) ──

export function tapTailRecord(file: string): { lastSeq: number; lastEntryHash?: string } {
  if (!existsSync(file)) return { lastSeq: -1 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]) as TapRec;
      const eff = (r.lastSeq ?? r.seq) as number | undefined;
      return { lastSeq: typeof eff === "number" ? eff : -1, lastEntryHash: r.entryHash as string | undefined };
    } catch {
      /* 손상 줄은 건너뛰고 이전 유효 레코드를 권위로(capture tailRecord 동형) */
    }
  }
  return { lastSeq: -1 };
}

/**
 * 파일 단위 체인 로그. 쓰기 주체는 자기 프로세스 하나(서버·프로세스 단위 파일 · §5.0)라 락 불요.
 * 비동기 큐(상한 1000) — 디스크가 느리면 frame 을 기다리게 하지 말고 드랍(드랍은 dropped:N 자백).
 */
export class TapLog {
  readonly file: string;
  private lastEntryHash: string | undefined;
  private seqCounter: number;
  private pending: string[] = [];
  private writing = false;
  private degradedNow = false;
  private droppedSinceMark = 0;
  private queueCap: number;

  constructor(dir: string, baseName: string, queueCap = 1000) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, baseName);
    const tail = tapTailRecord(this.file);
    this.lastEntryHash = tail.lastEntryHash;
    this.seqCounter = tail.lastSeq; // 파일 최초면 -1 → 첫 nextSeq()=0 · 기존 파일이면 체인·seq 이어받기(§5.1)
    this.queueCap = queueCap;
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }

  append(rec: TapRec): void {
    if (this.pending.length >= this.queueCap) {
      // 체인에 넣기 전에 드랍 → prevHash 연속 보존 · seq 갭이 남아 사후에도 드러난다(정직).
      this.droppedSinceMark += 1;
      this.degradedNow = true;
      return;
    }
    if (this.degradedNow && this.droppedSinceMark > 0) {
      const marker: TapRec = {
        schemaVersion: TAP_SCHEMA,
        kind: "marker",
        seq: this.nextSeq(),
        ts: (rec.ts as string) ?? (rec.firstTs as string) ?? new Date().toISOString(),
        markers: ["dropped:" + this.droppedSinceMark],
      };
      this.droppedSinceMark = 0;
      this.degradedNow = false;
      this.chainPush(marker);
    }
    this.chainPush(rec);
  }

  get dropped(): number {
    return this.droppedSinceMark;
  }

  private chainPush(rec: TapRec): void {
    if (this.lastEntryHash) rec.prevHash = this.lastEntryHash;
    rec.entryHash = tapEntryHash(rec);
    this.lastEntryHash = rec.entryHash as string;
    this.pending.push(JSON.stringify(rec));
    this.kick();
  }

  private kick(): void {
    if (this.writing || this.pending.length === 0) return;
    this.writing = true;
    const lines = this.pending.splice(0);
    appendFile(this.file, lines.join("\n") + "\n", (err) => {
      this.writing = false;
      if (err) {
        // 디스크 실패분은 유실 — 파일 체인의 prevHash 불연속으로도 드러난다(은폐 없음).
        this.degradedNow = true;
        this.droppedSinceMark += lines.length;
      }
      this.kick();
    });
  }

  async drain(maxMs = 2000): Promise<void> {
    const t0 = Date.now();
    while ((this.pending.length || this.writing) && Date.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  flushSyncBestEffort(): void {
    try {
      if (this.pending.length) appendFileSync(this.file, this.pending.splice(0).join("\n") + "\n");
    } catch {
      /* 최선노력 — exit code 전파가 우선 */
    }
  }
}

// ────────────────────────────────────────── 검증 코어 (§5.4 · tap verify 가 소비) ──

export type TapVerifyResult = {
  records: number;
  tampered: number;
  chainBreaks: number;
  seqGaps: number;
  coalesceErrors: number;
  cleanShutdown: boolean;
  problems: string[];
};

export function verifyTapFile(file: string): TapVerifyResult {
  const res: TapVerifyResult = { records: 0, tampered: 0, chainBreaks: 0, seqGaps: 0, coalesceErrors: 0, cleanShutdown: false, problems: [] };
  if (!existsSync(file)) return res;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prevHash: string | undefined;
  let prevEnd = -1;
  let lastKind = "";
  for (let i = 0; i < lines.length; i++) {
    let r: TapRec;
    try {
      r = JSON.parse(lines[i]) as TapRec;
    } catch {
      res.problems.push(`${i + 1}행: JSON 손상`);
      continue;
    }
    res.records += 1;
    if (r.entryHash !== tapEntryHash(r)) {
      res.tampered += 1;
      res.problems.push(`${i + 1}행: entryHash 불일치(변조 의심)`);
    }
    if (prevHash && r.prevHash !== prevHash) {
      res.chainBreaks += 1;
      res.problems.push(`${i + 1}행: prevHash 불연속(삭제/재정렬 의심)`);
    }
    prevHash = r.entryHash as string | undefined;
    const start = (r.firstSeq ?? r.seq) as number | undefined;
    const end = (r.lastSeq ?? r.seq) as number | undefined;
    if (typeof start === "number" && typeof end === "number") {
      if (start !== prevEnd + 1) res.seqGaps += 1; // 갭=드랍 자백(dropped:N)과 대조할 사실
      if (typeof r.repeat === "number" && r.repeat !== end - start + 1) {
        res.coalesceErrors += 1;
        res.problems.push(`${i + 1}행: repeat 산술 불일치`);
      }
      prevEnd = end;
    }
    lastKind = String(r.kind ?? "");
  }
  res.cleanShutdown = lastKind === "shutdown";
  return res;
}

// ────────────────────────────────────────── 관측 세션 (§6 · 순수 코어) ──

export interface TapSessionOpts {
  serverName: string;
  sink: (rec: TapRec) => void;
  nextSeq: () => number;
  now?: () => string; // ts(reported 등급) 주입 가능 — 결정론 테스트용
  nowMs?: () => number; // latency/TTL 시계 주입 가능
  maxBuf?: number;
  pendingCap?: number; // 결정 9: 4096
  ttlMs?: number; // 결정 9: 5분
}

const TRACKED_METHODS = new Set(["tools/call", "resources/read", "prompts/get", "initialize", "tools/list"]);

type PendingReq = { method: string; tool?: string; shape?: ArgShape; uriPart?: TapRec; cls?: string[]; t: number; untracked?: true };

export function createTapSession(o: TapSessionOpts): { clientData(b: Buffer): void; serverData(b: Buffer): void; end(): void } {
  const now = o.now ?? (() => new Date().toISOString());
  const nowMs = o.nowMs ?? (() => Date.now());
  const cap = o.pendingCap ?? 4096;
  const ttl = o.ttlMs ?? 5 * 60 * 1000;
  const co = new Coalescer(1000);
  const emit = (rec: TapRec): void => {
    for (const r of co.push(rec)) o.sink(r);
  };
  const pending = new Map<string, PendingReq>();
  const cSplit = createFrameSplitter(o.maxBuf);
  const sSplit = createFrameSplitter(o.maxBuf);

  function base(kind: string): TapRec {
    return { schemaVersion: TAP_SCHEMA, kind, seq: o.nextSeq(), ts: now(), server: o.serverName };
  }

  function evict(key: string, why: string): void {
    const p = pending.get(key);
    if (!p) return;
    pending.delete(key);
    if (p.untracked) return; // 미추적 요청은 이미 rpc 레코드로 남았다 — 퇴출 소음 없음
    const rec = base("call");
    rec.rpc = { id: key.slice(key.indexOf(":") + 1), method: p.method };
    rec.tool = { name: p.tool ?? p.method, ...(p.shape ?? { argsDigest: null }) };
    if (p.uriPart) Object.assign(rec, p.uriPart);
    if (p.cls) rec.class = p.cls;
    rec.markers = ["unpaired", why];
    emit(rec);
  }

  function sweep(t: number): void {
    for (const [k, p] of pending) {
      if (t - p.t > ttl) evict(k, "ttl");
      else break; // Map 삽입순 = 시간순
    }
  }

  function onMsg(dir: "c2s" | "s2c", msg: unknown, rawLine: string): void {
    const t = nowMs();
    sweep(t);
    const m = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown> } & Record<string, unknown>;
    const hasId = m != null && m.id !== undefined && m.id !== null;
    const isReq = hasId && typeof m.method === "string";
    const isNotif = !hasId && m != null && typeof m.method === "string";
    const isResp = hasId && !isReq && m != null && ("result" in m || "error" in m);

    if (isNotif) {
      const r = base("notification");
      r.method = m.method;
      r.dir = dir;
      emit(r);
      return;
    }

    if (isReq) {
      if (dir === "c2s" && TRACKED_METHODS.has(m.method as string)) {
        const key = "c2s:" + String(m.id);
        if (pending.size >= cap) {
          const oldest = pending.keys().next().value as string | undefined;
          if (oldest) evict(oldest, "cap"); // 결정 9: 상한 초과는 자백형 퇴출
        }
        const p: PendingReq = { method: m.method as string, t };
        if (m.method === "tools/call") {
          const params = m.params ?? {};
          p.tool = typeof params.name === "string" ? (params.name as string) : "(unknown)";
          p.shape = argShape((params as { arguments?: unknown }).arguments, rawLine);
          p.cls = classifyCall(o.serverName, p.tool, (params as { arguments?: unknown }).arguments);
          // 원문(arguments)은 여기서 수명 종료 — 이후 어디에도 값이 없다(G4).
        } else if (m.method === "resources/read") {
          p.shape = argShape(m.params, rawLine);
          const uri = (m.params as { uri?: unknown } | undefined)?.uri;
          if (typeof uri === "string") {
            p.uriPart = summarizeUri(uri);
            p.cls = (p.uriPart as { uri?: unknown }).uri ? ["fs-read"] : ["unknown"];
          } else p.cls = ["unknown"];
        } else if (m.method === "prompts/get") {
          p.shape = argShape(m.params, rawLine);
          p.cls = ["unknown"];
        }
        pending.set(key, p);
        return; // 레코드는 응답 도착(페어링) 시 1건으로
      }
      // 그 외 method·서버발 요청 = method 명만(§6.2)
      const r = base("rpc");
      r.method = m.method;
      r.dir = dir;
      emit(r);
      if (dir === "c2s") {
        // 미추적 요청 id 도 기억(같은 상한/TTL) — 응답이 orphan 으로 오탐되는 소음 차단(예: 주기적 ping).
        if (pending.size >= cap) {
          const oldest = pending.keys().next().value as string | undefined;
          if (oldest) evict(oldest, "cap");
        }
        pending.set("c2s:" + String(m.id), { method: m.method as string, t, untracked: true });
      }
      return;
    }

    if (isResp && dir === "s2c") {
      const key = "c2s:" + String(m.id);
      const p = pending.get(key);
      if (!p) {
        const r = base("call");
        r.rpc = { id: String(m.id), method: null };
        r.result = { status: "orphan" };
        emit(r);
        return;
      }
      pending.delete(key);
      if (p.untracked) return; // 요청이 이미 rpc 로 기록됨 — 응답은 무기록(고아 오탐 방지)
      if (p.method === "initialize") {
        const r = base("serverInfo");
        const pv = (m.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        r.protocolVersion = typeof pv === "string" ? pv : null;
        emit(r);
        return;
      }
      if (p.method === "tools/list") {
        const tools = (m.result as { tools?: unknown } | undefined)?.tools;
        const names = Array.isArray(tools) ? tools.map((x) => String((x as { name?: unknown })?.name ?? "")).sort() : [];
        const r = base("toolSurface");
        r.count = names.length;
        r.digest = jcsDigest(names); // 이름 목록은 저장하지 않는다 — 표면 스냅샷 digest 만(§5.1)
        emit(r);
        return;
      }
      const r = base("call");
      r.rpc = { id: String(m.id), method: p.method };
      r.tool = { name: p.tool ?? p.method, ...(p.shape ?? { argsDigest: null }) };
      if (p.uriPart) Object.assign(r, p.uriPart);
      const status = "error" in m ? "error" : "ok";
      const res: TapRec = { status };
      if (status === "ok") {
        res.isError = (m.result as { isError?: unknown } | undefined)?.isError === true;
        try {
          res.resultDigest = jcsDigest(m.result);
          res.resultBytes = Buffer.byteLength(JSON.stringify(m.result) ?? "", "utf8");
        } catch {
          res.canonFailed = true;
          res.frameDigest = sha256Of(rawLine);
        }
      }
      const lat = t - p.t;
      if (lat >= 0) res.latencyMs = lat;
      r.result = res;
      r.class = p.cls ?? ["unknown"];
      emit(r);
      return;
    }

    if (isResp) {
      // 서버발 요청에 대한 클라이언트 응답(c2s) 등 — method 만.
      const r = base("rpc");
      r.method = "(response)";
      r.dir = dir;
      emit(r);
    }
  }

  function onEvents(dir: "c2s" | "s2c", evs: FrameEvent[]): void {
    for (const ev of evs) {
      if (ev.opaque) {
        const r = base("opaque");
        r.bytes = ev.opaque.bytes;
        r.frameDigest = ev.opaque.frameDigest;
        r.dir = dir;
        emit(r);
        continue;
      }
      const line = ev.line as string;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        const r = base("opaque");
        r.bytes = Buffer.byteLength(line, "utf8");
        r.frameDigest = sha256Of(line);
        r.dir = dir;
        emit(r);
        continue;
      }
      if (Array.isArray(msg)) {
        for (const one of msg) onMsg(dir, one, line); // 배치 frame 방어(요소별 · §6.1)
      } else {
        onMsg(dir, msg, line);
      }
    }
  }

  return {
    clientData(b: Buffer) {
      onEvents("c2s", cSplit.feed(b));
    },
    serverData(b: Buffer) {
      onEvents("s2c", sSplit.feed(b));
    },
    end() {
      for (const r of co.flush()) o.sink(r);
    },
  };
}

// ────────────────────────────────────────── 런타임 (§4/§7) ──

export function sanitizeServerName(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return s || "server";
}

function sigExit(signal: NodeJS.Signals | null): number {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  return 1;
}

/**
 * `agent-receipt mcp-tap --server-name <n> --log-dir <abs> [--config-hash <h>] -- <원본 커맨드...>`
 * 관측 전용 stdio 프록시. 반환 후에도 stdin/child 리스너로 프로세스가 살아있다(호출부는 즉시 return).
 */
export function runMcpTap(argv: string[]): void {
  const sep = argv.indexOf("--");
  if (sep === -1 || sep === argv.length - 1) {
    console.error("mcp-tap: '-- <원본 서버 커맨드>' 가 필요합니다. 예: agent-receipt mcp-tap --server-name x --log-dir /abs -- npx server");
    process.exit(2);
  }
  const opts = argv.slice(0, sep);
  const childCmd = argv.slice(sep + 1);
  const get = (f: string): string | undefined => {
    const i = opts.indexOf(f);
    return i >= 0 ? opts[i + 1] : undefined;
  };
  const server = sanitizeServerName(get("--server-name") ?? "server");
  // 결정 2: CWD 의존 금지 — install 이 절대경로를 굽는 게 정본. env/기본값은 마지막 방어(비우호 CWD 위험은 스펙 §5.0).
  const logDir = resolve(get("--log-dir") ?? process.env.AGENT_RECEIPT_TAP_LOG_DIR ?? join(process.cwd(), ".agent-guard", "tap"));
  const configHash = get("--config-hash") ?? null;
  const fileName = `${server}-${process.pid}.jsonl`;

  const child: ChildProcess = spawn(childCmd[0], childCmd.slice(1), {
    stdio: ["pipe", "pipe", "inherit"], // stderr 는 손대지 않는다(§4.1)
    env: process.env, // child 에 전달만 — 어디에도 기록하지 않는다(결정 5)
  });
  child.on("error", (e) => {
    console.error("mcp-tap: child 기동 실패: " + (e as Error).message);
    process.exit(127);
  });

  // 중계 우선 배선 — 관측(아래 data 리스너)이 무슨 예외를 내도 pipe 는 독립이다(fail-open 구조 보장).
  process.stdin.pipe(child.stdin!);
  child.stdout!.pipe(process.stdout);
  process.stdin.on("end", () => {
    try {
      child.stdin!.end();
    } catch {
      /* 무시 */
    }
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        /* 무시 */
      }
    });
  }

  let log: TapLog | null = null;
  let session: ReturnType<typeof createTapSession> | null = null;

  if (process.env.AGENT_RECEIPT_TAP_OFF === "1") {
    // 킬 스위치: 순수 중계 + bypass 마커 1줄(몰래 우회 없음 · §4.3). 체인 없는 단독 마커.
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, fileName), JSON.stringify({ schemaVersion: TAP_SCHEMA, kind: "marker", markers: ["bypass"], ts: new Date().toISOString(), server }) + "\n");
    } catch {
      /* fail-open */
    }
  } else {
    try {
      log = new TapLog(logDir, fileName);
      log.append({
        schemaVersion: TAP_SCHEMA,
        kind: "tapMeta",
        seq: log.nextSeq(),
        ts: new Date().toISOString(),
        tapVersion: installedVersion(),
        digestAlg: JCS_DIGEST_ALG,
        bootId: randomBytes(4).toString("hex") + "-" + process.pid,
        sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
        server: { name: server, cmdHash: jcsDigest(childCmd), transport: "stdio" },
        configHash,
        logDir,
      });
      session = createTapSession({
        serverName: server,
        nextSeq: () => log!.nextSeq(),
        sink: (r) => {
          try {
            log!.append(r);
          } catch {
            /* fail-open */
          }
        },
      });
      process.stdin.on("data", (b: Buffer) => {
        try {
          session!.clientData(b);
        } catch {
          /* fail-open: 관측 예외는 중계를 못 죽인다(I5) */
        }
      });
      child.stdout!.on("data", (b: Buffer) => {
        try {
          session!.serverData(b);
        } catch {
          /* fail-open */
        }
      });
    } catch {
      log = null;
      session = null; // 기록 파이프라인 기동 실패 — 중계는 계속(조용한 사각지대 대신 파일 부재가 증거)
    }
  }

  child.on("exit", (code, signal) => {
    void (async () => {
      try {
        session?.end(); // 열린 병합 창 flush(닫힘 조건 b: 스트림 종료)
        if (log) {
          log.append({ schemaVersion: TAP_SCHEMA, kind: "shutdown", seq: log.nextSeq(), ts: new Date().toISOString(), clean: true, childExit: code ?? sigExit(signal) });
          await log.drain(2000); // exit code 전파를 지연시키지 않는 최선노력(§7)
          log.flushSyncBestEffort();
        }
      } catch {
        /* 최선노력 */
      }
      process.exit(code ?? sigExit(signal));
    })();
  });
}
