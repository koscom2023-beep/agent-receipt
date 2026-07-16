// ── 완료 보고 자동 수집·검증 (P0-4 · 2026-07-16 owner GO) ──
//
// 두 단계 종료 구조. 봉인된 Work Receipt 를 사후 수정하지 않는다.
//   done  → Work Receipt 봉인 → pending-completion(대기 표식) 생성
//   Stop  → last_assistant_message 수집 → claim 추출 → Completion Verification Receipt(사이드카) → pending 종료
//
// 불변식(owner 지령):
//   1) 기존 Work Receipt 는 절대 수정하지 않는다. 완료 검증은 별도 사이드카(<receipt>.completion.json).
//   2) transcript 를 "이번 턴 최종 답변"의 원천으로 쓰지 않는다 — Stop 이 준 last_assistant_message 를 쓴다.
//   3) 모든 Stop 을 무차별 저장하지 않는다 — pending 이 있을 때만 작동한다.
//   4) 추가 AI 판정·Stop 재호출 루프 없음. 훅은 비차단(항상 exit 0).
//   5) "최종 답변을 잡았다"는 reported, git·해시·검사 재계산만 verified.
//   6) 완료 원문(최종 답변)은 로컬만 — 서버 전송·기본 share-proof 포함 금지.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as g from "./git.js";
import { loadSession } from "./session.js";
import { sha256 } from "./environment.js";
import { writeFileAtomic } from "./lock.js";
import { parseHookStdin } from "./cursor-hook.js";
import { writeVerificationReceipt, tierProvenance } from "./vreceipt.js";
import type { Receipt } from "./receipt.js";

export const COMPLETION_SCHEMA_VERSION = "completion/1";
const GUARD_DIR = ".agent-guard";
export const PENDING_REL = join(GUARD_DIR, "pending-completion.json");
const COMPLETIONS_DIR_REL = join(GUARD_DIR, "completions");
/** Completion Verification Receipt 는 Work Receipt 의 사이드카로 붙는다(연결·비파괴). listReceipts 가 제외해야 함. */
export const COMPLETION_SIDECAR_SUFFIX = ".completion.json";

// ── 타입 ──
export type ClaimStatus = "VERIFIED" | "MISMATCH" | "ABSTAIN";
/** 추출기 산출 상태. 파싱 실패를 "주장 없음"으로 세탁하지 않는다(넷을 구분한다). */
export type ExtractionStatus = "EXTRACTED" | "NO_EXPLICIT_CLAIMS" | "UNSUPPORTED_FORMAT" | "DEGRADED";
export type CompletionVendor = "claude-code" | "codex" | "unknown";

export interface CompletionClaim {
  kind: "commit" | "test" | "file" | "branch" | "deploy" | "push";
  statement: string; // 사람이 읽는 짧은 문장(표시 전 마스킹)
  value?: string; // commit sha / branch / file / deploy 대상
  passed?: number; // test
  total?: number; // test
}
export interface VerifiedClaim extends CompletionClaim {
  status: ClaimStatus;
  evidence: string; // 무엇을 어떻게 대조했나
}
export interface ExtractionResult {
  status: ExtractionStatus;
  claims: CompletionClaim[];
}

export interface ProviderSession {
  name: CompletionVendor;
  sessionId: string | null;
  firstSeenAt: string;
  boundObservationWindowId: string | null;
}
export interface PendingCompletion {
  schemaVersion: string;
  status: "pending" | "finalized";
  agentReceiptSessionId: string;
  observationWindowId: string | null;
  workReceiptPath: string; // repo 상대
  workReceiptId: string; // = Work Receipt contentHash(별도 receiptId 필드 없음)
  workReceiptContentHash: string;
  repositoryRootDigest: string;
  createdAt: string;
  providerSession?: ProviderSession | null;
  shareProofPath?: string | null; // P0-4F: Stop 전 share 가 요청한 HTML(있으면 최종화 후 재렌더)
  completionId?: string | null; // finalized 일 때 어느 completion 으로 종료됐나(멱등키)
  lastStopError?: string | null; // Stop 은 발화했으나 최종화 실패한 원인(doctor 표면)
}

export interface CompletionSource {
  vendor: CompletionVendor;
  providerSessionId: string | null;
  turnId: string | null;
  capturedAt: string;
  workReceiptId: string;
  textSha256: string;
  textByteLength: number;
}

// ── 경로 헬퍼 ──
export function pendingPath(cwd: string = process.cwd()): string {
  return join(g.repoRoot() ?? cwd, PENDING_REL);
}
function completionsDir(cwd: string): string {
  return join(g.repoRoot() ?? cwd, COMPLETIONS_DIR_REL);
}
function repoRootDigest(cwd: string): string {
  return sha256(g.repoRoot() ?? cwd);
}

// ── pending 표식 R/W ──
export function loadPending(cwd: string = process.cwd()): PendingCompletion | null {
  const p = pendingPath(cwd);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (o && typeof o === "object" && typeof (o as PendingCompletion).workReceiptId === "string") {
      return o as PendingCompletion;
    }
  } catch {
    /* 깨진 pending → 없음으로 취급(크래시 금지). 다음 done 이 새로 쓴다. */
  }
  return null;
}

/**
 * done 이 Work Receipt 봉인 후 호출. RUNTIME_OUTPUT(범위 판정 밖). git 커밋 대상 아님.
 * 이미 pending 이 있으면 새 Work Receipt 로 명시 교체한다(조용한 덮어쓰기 아님 — done 이 로그로 알린다).
 * 반환: {created, superseded} — done 이 사용자에게 사실을 말하게.
 */
export function writePendingCompletion(r: Receipt, workReceiptRel: string, cwd: string = process.cwd()): { created: boolean; superseded: PendingCompletion | null } {
  const prev = loadPending(cwd);
  // 같은 Work Receipt 로 이미 pending 이 있으면 그대로 둔다(멱등 — done 재실행이 대기 표식을 리셋하지 않게).
  if (prev && prev.status === "pending" && prev.workReceiptId === r.contentHash) {
    return { created: false, superseded: null };
  }
  const sess = loadSession(cwd);
  const windowId = sess?.observationWindowId ?? null;
  const pend: PendingCompletion = {
    schemaVersion: COMPLETION_SCHEMA_VERSION,
    status: "pending",
    agentReceiptSessionId: windowId ?? sha256([g.repoRoot() ?? cwd, r.contentHash].join(" ")).slice(0, 24),
    observationWindowId: windowId,
    workReceiptPath: workReceiptRel,
    workReceiptId: r.contentHash,
    workReceiptContentHash: r.contentHash,
    repositoryRootDigest: repoRootDigest(cwd),
    createdAt: new Date().toISOString(),
    providerSession: null,
    shareProofPath: null,
    completionId: null,
    lastStopError: null,
  };
  const p = pendingPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(pend, null, 2) + "\n");
  const superseded = prev && prev.status === "pending" && prev.workReceiptId !== r.contentHash ? prev : null;
  return { created: true, superseded };
}

/** share 가 Stop 전에 실행되면 재렌더할 HTML 경로를 pending 에 기록(P0-4F 최소 허용). pending 없으면 no-op. */
export function recordShareRequest(htmlRel: string, cwd: string = process.cwd()): void {
  const pend = loadPending(cwd);
  if (!pend || pend.status !== "pending") return;
  pend.shareProofPath = htmlRel;
  try {
    writeFileAtomic(pendingPath(cwd), JSON.stringify(pend, null, 2) + "\n");
  } catch {
    /* 기록 실패는 비차단(share 자체는 성공) */
  }
}

// ── Stop 훅 payload 파싱(벤더 중립·transcript 를 원천으로 쓰지 않음) ──
export interface StopPayload {
  vendor: CompletionVendor;
  sessionId: string | null;
  turnId: string | null;
  finalText: string; // last_assistant_message 원문(없으면 "")
  hasField: boolean; // last_assistant_message 필드 자체가 있었나(형식 지원 판정)
}
export function parseStopPayload(payload: unknown): StopPayload {
  const o = (payload ?? {}) as Record<string, unknown>;
  // 벤더 판정: cursor_version/conversation_id=cursor·turn_id+model=codex·그 외 claude.
  const ev = String(o.hook_event_name ?? o.hookEventName ?? "");
  let vendor: CompletionVendor = "unknown";
  if (typeof o.cursor_version === "string" || typeof o.conversation_id === "string") vendor = "unknown"; // Cursor 완료 미지원(정직)
  else if (typeof o.turn_id === "string" || (typeof o.model === "string" && o.permission_mode === undefined && o.transcript_path === undefined)) vendor = "codex";
  else if (typeof o.session_id === "string" || ev === "Stop" || typeof o.transcript_path === "string" || typeof o.permission_mode === "string") vendor = "claude-code";
  const sid = o.session_id ?? o.sessionId ?? o.conversation_id;
  const sessionId = typeof sid === "string" ? sid : null;
  const tid = o.turn_id ?? o.turnId ?? o.prompt_id ?? o.promptId;
  const turnId = typeof tid === "string" ? tid : null;
  // last_assistant_message = 이번 턴 최종 답변의 SSOT(공식 문서). transcript 는 보조일 뿐 원천 아님.
  const lam = o.last_assistant_message ?? o.lastAssistantMessage;
  const hasField = typeof lam === "string";
  const finalText = typeof lam === "string" ? lam : "";
  return { vendor, sessionId, turnId, finalText, hasField };
}

// ── 완료 claim 추출(결정론·LLM 호출 0) ──
// 구조화된 completion claim 블록이 있으면 최우선. 없으면 고신호 문장 휴리스틱(기존 지원 범위).
// 애매한 문장을 억지로 구조화하지 않는다 — 명시 추출 가능한 주장만.
const COMMIT_RE = /(?:commit(?:ted)?|커밋)\s+`?([0-9a-f]{7,40})`?/gi;
const TEST_RE = /(\d{1,6})\s*\/\s*(\d{1,6})\s*(?:개\s*)?(?:테스트\s*)?(?:통과|passed|passing|pass\b|성공|green)/gi;
const DEPLOY_RE = /\b(vercel|netlify|cloudflare|render|fly\.io|railway|supabase|배포\s*(?:완료|했)|deployed|published\s+to|publish(?:ed)?\s+npm|npm\s+publish)\b/gi;
const PUSH_RE = /\b(git\s+push|pushed?\s+to|푸시\s*(?:완료|했)|push\s+완료)\b/gi;

/** 구조화 블록: ```agent-receipt-claim {json} ``` 또는 <!--agent-receipt-claim {json}-->. */
function extractStructuredBlock(text: string): { found: boolean; parsed: unknown | null; malformed: boolean } {
  const fence = text.match(/```agent-receipt-claims?\s*\n([\s\S]*?)```/i);
  const html = text.match(/<!--\s*agent-receipt-claims?\s*([\s\S]*?)-->/i);
  const body = fence?.[1] ?? html?.[1];
  if (body === undefined) return { found: false, parsed: null, malformed: false };
  try {
    return { found: true, parsed: JSON.parse(body), malformed: false };
  } catch {
    return { found: true, parsed: null, malformed: true }; // 블록은 있으나 깨짐 → DEGRADED(세탁 금지)
  }
}

function claimsFromStructured(parsed: unknown): CompletionClaim[] {
  const out: CompletionClaim[] = [];
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { claims?: unknown }).claims)
      ? (parsed as { claims: unknown[] }).claims
      : [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const kind = String(c.kind ?? "");
    if (kind === "commit" && typeof c.value === "string") out.push({ kind: "commit", value: c.value, statement: `commit ${c.value}` });
    else if (kind === "branch" && typeof c.value === "string") out.push({ kind: "branch", value: c.value, statement: `branch ${c.value}` });
    else if (kind === "file" && typeof c.value === "string") out.push({ kind: "file", value: c.value, statement: `changed ${c.value}` });
    else if (kind === "deploy") out.push({ kind: "deploy", value: typeof c.value === "string" ? c.value : "deploy", statement: `deploy ${typeof c.value === "string" ? c.value : ""}`.trim() });
    else if (kind === "push") out.push({ kind: "push", statement: "push" });
    else if (kind === "test" && typeof c.passed === "number" && typeof c.total === "number")
      out.push({ kind: "test", passed: c.passed, total: c.total, statement: `tests ${c.passed}/${c.total}` });
  }
  return out;
}

function heuristicClaims(text: string): CompletionClaim[] {
  const out: CompletionClaim[] = [];
  const seen = new Set<string>();
  const add = (c: CompletionClaim) => {
    const key = `${c.kind}:${c.value ?? ""}:${c.passed ?? ""}/${c.total ?? ""}`;
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  };
  let m: RegExpExecArray | null;
  COMMIT_RE.lastIndex = 0;
  while ((m = COMMIT_RE.exec(text))) add({ kind: "commit", value: m[1].toLowerCase(), statement: `commit ${m[1]}` });
  TEST_RE.lastIndex = 0;
  while ((m = TEST_RE.exec(text))) add({ kind: "test", passed: Number(m[1]), total: Number(m[2]), statement: `tests ${m[1]}/${m[2]} pass` });
  DEPLOY_RE.lastIndex = 0;
  if (DEPLOY_RE.exec(text)) add({ kind: "deploy", value: "deploy", statement: "deploy/publish claimed" });
  PUSH_RE.lastIndex = 0;
  if (PUSH_RE.exec(text)) add({ kind: "push", statement: "git push claimed" });
  return out;
}

/**
 * extractCompletionClaims — transcript 아닌 최종 답변 텍스트에서 명시 주장만 추출.
 * 결과 상태를 구분한다: EXTRACTED / NO_EXPLICIT_CLAIMS / UNSUPPORTED_FORMAT / DEGRADED.
 */
export function extractCompletionClaims(input: { text: string; vendor: CompletionVendor; sourceDigest?: string }): ExtractionResult {
  const text = input.text ?? "";
  if (!text.trim()) return { status: "NO_EXPLICIT_CLAIMS", claims: [] };
  const block = extractStructuredBlock(text);
  if (block.found && block.malformed) return { status: "DEGRADED", claims: [] }; // 블록 있으나 파싱 실패 — 세탁 금지
  const structured = block.parsed ? claimsFromStructured(block.parsed) : [];
  if (structured.length) return { status: "EXTRACTED", claims: structured }; // 구조화 최우선
  const heur = heuristicClaims(text);
  if (heur.length) return { status: "EXTRACTED", claims: heur };
  return { status: "NO_EXPLICIT_CLAIMS", claims: [] };
}

// ── 완료 claim 검증(git·해시·검사 재계산만 verified) ──
export function verifyCompletionClaims(claims: CompletionClaim[], work: Receipt, cwd: string = process.cwd()): VerifiedClaim[] {
  const gitChanged = new Set<string>([...work.touched, ...work.staged, ...work.untracked].map((p) => p.replace(/\\/g, "/")));
  const branch = g.currentBranch();
  const checks = work.checks ?? [];
  const gitPass = checks.length > 0 && checks.every((c) => c.ok);
  return claims.map((c): VerifiedClaim => {
    if (c.kind === "commit") {
      const exists = c.value ? g.commitExists(c.value) : false;
      return { ...c, status: exists ? "VERIFIED" : "MISMATCH", evidence: exists ? `git: commit ${c.value} 존재` : `git: commit ${c.value ?? "(없음)"} 없음` };
    }
    if (c.kind === "branch") {
      const ok = c.value === branch;
      return { ...c, status: ok ? "VERIFIED" : "MISMATCH", evidence: `git: 현재 브랜치 ${branch}${ok ? "" : ` ≠ 주장 ${c.value ?? "(없음)"}`}` };
    }
    if (c.kind === "file") {
      const f = (c.value ?? "").replace(/\\/g, "/");
      const ok = gitChanged.has(f);
      return { ...c, status: ok ? "VERIFIED" : "MISMATCH", evidence: ok ? `Work Receipt: ${f} 변경됨` : `Work Receipt: ${f} 변경 없음(주장만)` };
    }
    if (c.kind === "test") {
      if (checks.length === 0) return { ...c, status: "ABSTAIN", evidence: "Work Receipt에 검사 명령이 없어 테스트 수를 독립적으로 확인할 근거가 없음" };
      const aiPass = (c.passed ?? 0) === (c.total ?? -1) && (c.total ?? 0) > 0;
      const ok = aiPass === gitPass;
      return { ...c, status: ok ? "VERIFIED" : "MISMATCH", evidence: `Work Receipt 검사: ${gitPass ? "전부 통과" : `실패 ${checks.filter((x) => !x.ok).length}건`}` };
    }
    // deploy / push — git 은 배포·네트워크를 직접 못 본다. 독립 증거 없음 → ABSTAIN(FAIL 아님).
    return { ...c, status: "ABSTAIN", evidence: "독립 증거가 없어 판단할 수 없음. git은 배포나 push의 최종 상태를 직접 관측하지 못함" };
  });
}

// ── handoffVerdict(읽기 전용·share-proof 가 계산·저장 안 함) ──
export type HandoffVerdict = "PASS" | "FAIL" | "PASS_WITH_WARNINGS" | "INCOMPLETE" | "PENDING";
export interface CompletionSummary {
  captured: boolean;
  extractionStatus: ExtractionStatus | null;
  claims: VerifiedClaim[];
  verified: number;
  mismatch: number;
  abstain: number;
}
/**
 * Work Receipt 판정은 바꾸지 않는다. 최종 전달 판정만 읽기 전용으로 조립.
 * Work FAIL→FAIL · Work PASS+MISMATCH→FAIL · Work PASS+VERIFIED→PASS
 * Work PASS+ABSTAIN 일부→PASS_WITH_WARNINGS · Work PASS+NOT_CAPTURED/DEGRADED→INCOMPLETE.
 */
export function computeHandoffVerdict(workOk: boolean, comp: CompletionSummary | null): HandoffVerdict {
  if (!workOk) return "FAIL"; // Work FAIL 이면 완료 보고와 무관하게 FAIL
  if (!comp || !comp.captured) return "INCOMPLETE"; // 최종 보고 미수집(NOT_CAPTURED)
  if (comp.extractionStatus === "DEGRADED" || comp.extractionStatus === "UNSUPPORTED_FORMAT") return "INCOMPLETE";
  if (comp.mismatch > 0) return "FAIL"; // 거짓 완료 보고 — 코드가 계약을 지켜도 PASS 로 보이면 안 된다
  if (comp.extractionStatus === "NO_EXPLICIT_CLAIMS") return "PASS_WITH_WARNINGS"; // 수집됐으나 검증할 주장 없음
  if (comp.abstain > 0) return "PASS_WITH_WARNINGS"; // 확인됐지만 일부는 판단 불가
  return "PASS"; // 전부 확인
}

export const HANDOFF_LABEL: Record<HandoffVerdict, string> = {
  PASS: "PASS",
  FAIL: "FAIL",
  PASS_WITH_WARNINGS: "PASS(경고)",
  INCOMPLETE: "INCOMPLETE",
  PENDING: "PENDING",
};

// ── Completion Verification Receipt 로드(share-proof 가 읽기 전용으로 소비) ──
export function completionSidecarPath(workReceiptAbs: string): string {
  return workReceiptAbs + COMPLETION_SIDECAR_SUFFIX;
}
/** Work Receipt abs 옆의 완료 검증 사이드카를 CompletionSummary 로 읽는다. 없으면 null(=미수집). */
export function loadCompletionSummary(workReceiptAbs: string): CompletionSummary | null {
  const p = completionSidecarPath(workReceiptAbs);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (o.kind !== "verification-receipt" || o.surface !== "completion") return null;
    const results = Array.isArray(o.results) ? (o.results as VerifiedClaim[]) : [];
    const ext = (o as { extractionStatus?: ExtractionStatus }).extractionStatus ?? null;
    return {
      captured: true,
      extractionStatus: ext,
      claims: results,
      verified: results.filter((r) => r.status === "VERIFIED").length,
      mismatch: results.filter((r) => r.status === "MISMATCH").length,
      abstain: results.filter((r) => r.status === "ABSTAIN").length,
    };
  } catch {
    return null;
  }
}

// ── Stop 훅 진입점: capture --event stop 이 라우팅 ──
// 비차단·increment 없음·추가 AI 판정 없음. pending 이 있을 때만 작동한다.
// async 인 이유: P0-4F 재렌더(HTML 표현물 재생성)가 동적 import 라 exit 전에 await 로 완료 보장.
export async function runCompletionStop(vendorHint: "claude" | "cursor" | "auto" = "auto", cwd: string = process.cwd()): Promise<never> {
  if (process.stdin.isTTY) process.exit(0); // 파이프 입력 없으면 무동작
  // pending 이 없으면 이 Stop 은 진행 보고·질문 답변일 뿐 — 아무것도 하지 않는다(무차별 저장 금지).
  const pend = loadPending(cwd);
  if (!pend || pend.status !== "pending") process.exit(0);

  let raw = "";
  try {
    raw = readFileSync(0, "utf8").replace(/^﻿/, "");
  } catch {
    recordStopError(pend, "stdin 읽기 실패", cwd);
    process.exit(0);
  }
  let payload: unknown;
  try {
    payload = parseHookStdin(raw);
  } catch {
    recordStopError(pend, "stdin JSON 파싱 실패", cwd);
    process.exit(0);
  }
  const sp = parseStopPayload(payload);
  const vendor: CompletionVendor = vendorHint === "cursor" ? "unknown" : sp.vendor;

  // 공급자 세션 결합(P0-4B): 창에 아직 세션이 없으면 결합. 다른 세션이 들어오면 AMBIGUOUS(자동 교체 금지).
  const bind = bindProviderSession(pend, vendor, sp.sessionId, cwd);
  if (bind === "ambiguous") {
    recordStopError(pend, "AMBIGUOUS_PROVIDER_SESSION: 같은 창에 두 공급자 세션이 충돌해 자동 최종화를 중단함", cwd);
    process.exit(0);
  }

  // 최종 답변을 못 받으면(형식 미지원/빈 답변) 최종화하지 않는다 — pending 유지·원인 기록(성공처럼 삼키지 않음).
  if (!sp.hasField) {
    recordStopError(pend, `UNSUPPORTED_FORMAT: last_assistant_message 필드가 없음(vendor=${vendor})`, cwd);
    process.exit(0);
  }
  if (!sp.finalText.trim()) {
    recordStopError(pend, "NOT_CAPTURED: 최종 답변이 비어 있음", cwd);
    process.exit(0);
  }

  // Work Receipt 로드(연결·비파괴 — 절대 수정하지 않는다).
  const workAbs = isAbsolute(pend.workReceiptPath) ? pend.workReceiptPath : join(g.repoRoot() ?? cwd, pend.workReceiptPath);
  const work = loadWorkReceipt(workAbs);
  if (!work) {
    recordStopError(pend, `Work Receipt 로드 실패: ${pend.workReceiptPath}`, cwd);
    process.exit(0);
  }

  // 로컬 원문 저장(서버 전송 0). completionId = 결정론(멱등키).
  const textSha = createHash("sha256").update(sp.finalText).digest("hex");
  const completionId = createHash("sha256").update([pend.workReceiptId, sp.sessionId ?? "", sp.turnId ?? textSha].join(":")).digest("hex").slice(0, 16);
  const cdir = join(completionsDir(cwd), completionId);

  const extraction = extractCompletionClaims({ text: sp.finalText, vendor, sourceDigest: textSha });
  const verified = verifyCompletionClaims(extraction.claims, work, cwd);

  try {
    mkdirSync(cdir, { recursive: true });
    writeFileSync(join(cdir, "assistant-message.txt"), sp.finalText); // 로컬 전용
    const source: CompletionSource = {
      vendor,
      providerSessionId: sp.sessionId,
      turnId: sp.turnId,
      capturedAt: new Date().toISOString(),
      workReceiptId: pend.workReceiptId,
      textSha256: textSha,
      textByteLength: Buffer.byteLength(sp.finalText, "utf8"),
    };
    writeFileSync(join(cdir, "source.json"), JSON.stringify(source, null, 2) + "\n");
    writeFileSync(join(cdir, "claim.json"), JSON.stringify({ extractionStatus: extraction.status, claims: extraction.claims }, null, 2) + "\n");
  } catch (e) {
    recordStopError(pend, `DEGRADED: 완료 원문을 저장하지 못함(${e instanceof Error ? e.message : String(e)})`, cwd);
    process.exit(0);
  }

  // Completion Verification Receipt — 기존 Evidence Kernel(evidence/1) 재사용. Work Receipt 사이드카로 연결.
  const mismatch = verified.filter((v) => v.status === "MISMATCH").length;
  const summary = {
    claims: verified.length,
    verified: verified.filter((v) => v.status === "VERIFIED").length,
    mismatch,
    abstain: verified.filter((v) => v.status === "ABSTAIN").length,
  };
  try {
    // provenance: commit 존재는 계산검증(verified), 나머지는 reported. subject 로 Work Receipt 연결.
    const prov = tierProvenance({ commit: work.headHash, inputFiles: [] });
    // writeVerificationReceipt 는 봉인 본문을 만든 뒤 파일로 쓴다. 여기에 extractionStatus 를 얹기 위해
    // 사이드카는 한 번 더 읽어 additive 필드를 병합한다(봉인 필드는 불변 — 병합은 표시용 메타).
    const sidecar = completionSidecarPath(workAbs);
    writeVerificationReceipt(sidecar, {
      surface: "completion",
      inputFile: join(COMPLETIONS_DIR_REL, completionId, "assistant-message.txt"),
      inputRaw: sp.finalText,
      subject: `work-receipt:${pend.workReceiptId}`,
      provenance: prov,
      results: verified,
      summary,
      verdict: mismatch > 0 ? "fail" : "pass",
      verifiedAt: new Date().toISOString(),
    });
    // additive 메타(봉인 밖·표시용): extractionStatus·completionId·vendor. 봉인 본문은 재계산 안 함(무결성 유지).
    const receipt = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    receipt.extractionStatus = extraction.status;
    receipt.completionMeta = { completionId, vendor, providerSessionId: sp.sessionId, turnId: sp.turnId, workReceiptPath: pend.workReceiptPath };
    writeFileSync(sidecar, JSON.stringify(receipt, null, 2) + "\n");
  } catch (e) {
    recordStopError(pend, `DEGRADED: 완료 검증 영수증을 생성하지 못함(${e instanceof Error ? e.message : String(e)})`, cwd);
    process.exit(0);
  }

  // pending 종료(멱등키 기록). Work Receipt 는 손대지 않았다.
  finalizePending(pend, completionId, cwd);

  // P0-4F: Stop 전에 share 가 HTML 을 요청했으면 그 파일만 최종본으로 재렌더(영수증 수정 아님 — HTML 표현물 재생성).
  if (pend.shareProofPath) {
    try {
      const outAbs = isAbsolute(pend.shareProofPath) ? pend.shareProofPath : join(g.repoRoot() ?? cwd, pend.shareProofPath);
      // 동적 import(정적 순환 회피)·await 로 exit 전에 완료. optional 참조 = share-proof 표면이 없는 상태에서도 무해(no-op).
      const m = (await import("./shareproof.js")) as { rerenderProofTo?: (workAbs: string, outAbs: string, cwd: string) => void };
      m.rerenderProofTo?.(workAbs, outAbs, cwd);
    } catch {
      /* 재렌더 실패는 비차단(사용자가 직접 share 재실행 가능) */
    }
  }
  process.exit(0);
}

// ── 내부 헬퍼 ──
function recordStopError(pend: PendingCompletion, reason: string, cwd: string): void {
  pend.lastStopError = reason;
  try {
    writeFileAtomic(pendingPath(cwd), JSON.stringify(pend, null, 2) + "\n");
  } catch {
    /* 기록 실패도 비차단 */
  }
}
function finalizePending(pend: PendingCompletion, completionId: string, cwd: string): void {
  pend.status = "finalized";
  pend.completionId = completionId;
  pend.lastStopError = null;
  try {
    writeFileAtomic(pendingPath(cwd), JSON.stringify(pend, null, 2) + "\n");
  } catch {
    /* 최종화 기록 실패 → 다음 done 이 새 pending 을 만든다(사이드카는 이미 생성됨) */
  }
}
/** 첫 Stop 이 공급자 세션을 결합. 이미 결합됐고 다른 sessionId 면 ambiguous(자동 교체 금지). */
function bindProviderSession(pend: PendingCompletion, vendor: CompletionVendor, sessionId: string | null, cwd: string): "bound" | "same" | "ambiguous" {
  const existing = pend.providerSession ?? null;
  if (existing && existing.sessionId && sessionId && existing.sessionId !== sessionId) return "ambiguous";
  if (existing && existing.sessionId) return "same";
  pend.providerSession = {
    name: vendor,
    sessionId,
    firstSeenAt: new Date().toISOString(),
    boundObservationWindowId: pend.observationWindowId,
  };
  try {
    writeFileAtomic(pendingPath(cwd), JSON.stringify(pend, null, 2) + "\n");
  } catch {
    /* 결합 기록 실패는 비차단 */
  }
  return "bound";
}
function loadWorkReceipt(abs: string): Receipt | null {
  if (!existsSync(abs)) return null;
  try {
    const o = JSON.parse(readFileSync(abs, "utf8")) as Receipt;
    if (o && typeof o.ok === "boolean" && typeof o.contentHash === "string" && Array.isArray(o.touched)) return o;
  } catch {
    /* 손상 → null */
  }
  return null;
}
// doctor 용: 완료 보고 관측 상태 요약(디스크 읽기·판정 아님).
export interface CompletionHealth {
  hookInstalled: boolean; // Stop 완료 훅이 settings 에 배선됐나
  pending: PendingCompletion | null;
  provider: ProviderSession | null;
}
