import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, isAbsolute, relative } from "node:path";
import * as g from "./git.js";
import type { Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { resolveSession } from "./session.js";
import type { SessionKind } from "./start.js";
import { collectMagnitude, criticalPathHits, touchedFull, type Magnitude, type CriticalPath } from "./evidence.js";
import { captureEnvironment, type Environment } from "./environment.js";
import { loadPolicySafe, policyObservations, policyPath, type PolicyObs } from "./policy.js";
import { redactText, redactJsonText } from "./redact.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { loadCapturedActions, loadReconciliation, splitActionsForDisplay, type CaptureAction, type ActionsResult, type ReconResult } from "./capture.js";
import { renderVerdictLine, renderContractLine, type VerdictResult, type ContractSnapshot } from "./verdict.js"; // 런타임 순환 없음(verdict→receipt 는 type-only)
import { buildTapSummary, type TapSummary } from "./tap.js"; // mcp-tap 관측 요약(순환 없음 — tap 은 jcs/version 만 import)

// receipt JSON 스키마 버전(downstream/CI 가 안전하게 의존). additive only. verify --json 14키와 무관.
export const RECEIPT_SCHEMA_VERSION = "1.0";

// AI Work Receipt — verify(상태) + check(명령) 결과 스냅샷. verify --json(14키)와 별개 스키마.
export interface Receipt {
  schemaVersion: string; // receipt 스키마 버전(contentHash 입력엔 미포함 — metadata).
  ok: boolean;
  contractId: string;
  title: string | null;
  branch: { current: string; expected: string | null; ok: boolean };
  headHash: string;
  timestamp: string;
  touched: string[];
  staged: string[];
  untracked: string[];
  outOfScope: string[];
  deniedHits: string[];
  violations: string[];
  session: { applied: boolean; reason: string | null; baselineHead: string; kind?: SessionKind; objective?: string } | null;
  checks: { name: string; exitCode: number; requiredExit: number; ok: boolean }[];
  magnitude: Magnitude; // 변경 규모(full working tree 기준 — baseline-relative 아님)
  criticalPaths: CriticalPath[]; // 고위험 경로 touched/untouched (코드 상수 — 계약 필드 아님)
  policy: PolicyObs | null; // N8 트립와이어: policy.yaml 상시규칙 관찰(없으면 null)
  environment: Environment; // 환경/출처 캡처(git/node/os + 계약·정책 해시). contentHash 입력엔 미포함.
  disclosure: string; // 한계 고지(이 도구가 못 보는 것)
  measuredFrom?: string; // 커밋-모드일 때만: `committed:<base>` (측정 대상=base..HEAD 커밋). 미지정=작업트리. receiptHash 입력엔 미포함(메타·additive → 기존 영수증 바이트동일).
  contentHashes?: Array<{ path: string; sha256: string | null; bytes: number }>; // --content 일 때만: touched 파일 sha256(내용 저장 안 함). 있을 때만 contentHash 입력에 포함.
  actions?: CaptureAction[]; // capture(git 너머 행위). capture.jsonl 있을 때만. v0.24: 있으면 다이제스트로 receiptHash 봉인(proof HTML 이 그림). 없으면 키 부재.
  actionsSummary?: ActionsResult["actionsSummary"]; // 행위 요약(gitVisible 대비). receiptHash 입력 제외(actions 다이제스트가 대표).
  reconciliation?: ReconResult; // D4: git 변경 대 capture 대사(matched/미설명 residuals). capture 있을 때만. v0.24: 있으면 다이제스트로 receiptHash 봉인.
  verdict?: VerdictResult; // P0 D1(v0.17): 세션 판정(게이트·점수 아님). done 이 부착. v0.24: 있으면 receiptHash 에 봉인(판정 위변조 차단).
  contractSnapshot?: ContractSnapshot; // P0 D2: 계약 최소필드+contractHash 포인터. done 이 부착. v0.24: 있으면 receiptHash 에 봉인.
  tapSummary?: TapSummary; // mcp-tap 관측 요약(커서 이후 창). tap 레코드 있을 때만. receiptHash 입력 제외(자가 관측·판정 비유입·등급 C). 미사용=키 부재.
  contentHash: string; // sha256 무결성 해시. git 실측 + 판정(ok/violations/branch/contractId/verdict 등) 봉인. timestamp/environment/schemaVersion 제외. 아래 receiptHash 참고.
}

// 키를 정렬해 직렬화(객체 순서 비의존). 배열은 호출부에서 미리 정렬해 넣는다.
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce((o, k) => {
            o[k] = (val as Record<string, unknown>)[k];
            return o;
          }, {} as Record<string, unknown>)
      : val,
  );
}

// Receipt Integrity — Node 내장 crypto(sha256)만 사용(새 의존성 없음). 입력은 결정론적 git 실측:
// headHash + touched/staged/untracked/outOfScope/deniedHits(정렬) + magnitude + criticalTouched + checks.
// v0.24 보안수정(council 리뷰 #1 Critical): **사람이 읽는 판정**(ok·violations·branch·contractId·verdict·
//   contractSnapshot + actions/reconciliation 다이제스트)도 봉인에 포함한다. 이전엔 이 필드들이 제외돼서
//   서명·앵커된 영수증도 PASS/FAIL 을 봉인 파괴 없이 뒤집을 수 있었다(shareproof 는 r.ok 만 읽음). 이제
//   ok/verdict/violations 를 고치면 receiptHash 가 바뀌어 verify-proof 의 receipt-hash·dsse-subject 가 실패한다.
//   대가는 하위호환 깨짐(0.23 이전 영수증은 재계산 불일치로 verify 실패). 0.24 major-ish bump 로 처리.
// timestamp/environment/policy 는 여전히 제외(시간·머신마다 바뀜). 같은 git 상태에 같은 판정이면 같은 hash.
export function receiptHash(r: Receipt): string {
  const sha256hex = (s: string): string => "sha256:" + createHash("sha256").update(s).digest("hex");
  const payload = {
    headHash: r.headHash,
    touched: [...r.touched].sort(),
    staged: [...r.staged].sort(),
    untracked: [...r.untracked].sort(),
    outOfScope: [...r.outOfScope].sort(),
    deniedHits: [...r.deniedHits].sort(),
    magnitude: r.magnitude,
    criticalTouched: r.criticalPaths.flatMap((c) => c.touched).sort(),
    checks: r.checks.map((c) => `${c.name}:${c.exitCode}:${c.requiredExit}:${c.ok}`).sort(),
    // 사람이 읽는 판정(항상 존재)은 봉인 필수. 리뷰 #1 의 위조 시나리오(ok/violations/branch/contractId 위변조) 차단.
    ok: r.ok,
    violations: [...(r.violations ?? [])].sort(), // ?? [] 는 봉인 프리미티브가 부분 영수증에도 안 던지게(verify 중 크래시 방지)
    branch: r.branch,
    contractId: r.contractId,
    // done 이 부착하는 판정 필드(있을 때만 포함). 있으면 봉인, 없으면 키 부재.
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(r.contractSnapshot ? { contractSnapshot: r.contractSnapshot } : {}),
    // actions/reconciliation 는 클 수 있어 다이제스트로 봉인(내용 자체는 미저장·compact). proof HTML 이 이 값으로 그림.
    ...(r.actions && r.actions.length ? { actionsDigest: sha256hex(stableStringify(r.actions)) } : {}),
    ...(r.reconciliation ? { reconciliationDigest: sha256hex(stableStringify(r.reconciliation)) } : {}),
    // contentHashes 는 있을 때만 포함(backward-compatible · replay 호환).
    ...(r.contentHashes && r.contentHashes.length
      ? { contentHashes: r.contentHashes.map((c) => `${c.path}:${c.sha256 ?? "null"}`).sort() }
      : {}),
  };
  return "sha256:" + createHash("sha256").update(stableStringify(payload)).digest("hex");
}

// --content: touched 파일들의 sha256 만 기록(내용 저장 0 — council C4). 대용량은 해시 null + 바이트만(size cap).
const CONTENT_CAP_BYTES = 5 * 1024 * 1024;
function computeContentHashes(paths: string[]): NonNullable<Receipt["contentHashes"]> {
  const root = g.repoRoot() ?? process.cwd();
  const out: NonNullable<Receipt["contentHashes"]> = [];
  for (const p of [...new Set(paths)].sort()) {
    const abs = isAbsolute(p) ? p : join(root, p);
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        out.push({ path: p, sha256: null, bytes: 0 });
      } else if (st.size > CONTENT_CAP_BYTES) {
        out.push({ path: p, sha256: null, bytes: st.size }); // 대용량 → 해시 생략(메모리 보호)
      } else {
        out.push({ path: p, sha256: "sha256:" + createHash("sha256").update(readFileSync(abs)).digest("hex"), bytes: st.size });
      }
    } catch {
      out.push({ path: p, sha256: null, bytes: 0 }); // 삭제됨/못 읽음
    }
  }
  return out;
}

// ── 순수 빌드: verify+check+env+policy 를 모아 Receipt 객체를 만든다(write 없음). ──
// audit-pack·ledger·commit-check·done 이 재사용한다.
export interface BuildOpts {
  content?: boolean; // --content: touched 파일 sha256 기록
  agent?: string; // --agent: provenance(명시값)
  model?: string; // --model: provenance(명시값)
  committedBase?: string; // 커밋-모드(post-commit 증거): committedBase..HEAD 커밋 측정. 미지정=작업트리(기존).
}

export function buildReceipt(contract: Contract, contractPath?: string, opts: BuildOpts = {}): Receipt {
  const mopts = opts.committedBase !== undefined ? { committedBase: opts.committedBase } : {};
  const v = runVerify(contract, mopts);
  const chk = runCheck(contract);
  const sess = resolveSession();
  const { policy } = loadPolicySafe();
  const polObs = policy ? policyObservations(policy, touchedFull(mopts)) : null;
  const ppath = policy ? policyPath() : undefined;
  const r: Receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    ok: v.ok && chk.ok,
    contractId: v.contractId,
    title: v.title ?? null,
    branch: { current: v.branch.current, expected: v.branch.expected ?? null, ok: v.branch.ok },
    headHash: v.headHash,
    timestamp: new Date().toISOString(),
    touched: v.touched,
    staged: v.staged,
    untracked: v.untracked,
    outOfScope: v.outOfScope,
    deniedHits: v.deniedHits,
    violations: v.violations,
    session: sess.session
      ? {
          applied: sess.applied,
          reason: sess.reason,
          baselineHead: sess.session.baselineHead,
          ...(sess.session.kind ? { kind: sess.session.kind } : {}),
          ...(sess.session.objective ? { objective: sess.session.objective } : {}), // 배치A-6 — 자가보고(미검증)·hash 제외(session 자체가 hash 입력 밖)
        }
      : null,
    checks: chk.commands.map((c) => ({ name: c.name, exitCode: c.exitCode, requiredExit: c.requiredExit, ok: c.ok })),
    magnitude: collectMagnitude(mopts),
    criticalPaths: criticalPathHits(touchedFull(mopts)),
    policy: polObs,
    environment: captureEnvironment({ contractPath, policyPath: ppath, agent: opts.agent, model: opts.model }),
    disclosure: LIMIT_NOTE,
    // 커밋-모드일 때만 measuredFrom 표기(메타). receiptHash 입력엔 미포함 → 기본모드 영수증 바이트동일.
    ...(opts.committedBase !== undefined ? { measuredFrom: `committed:${opts.committedBase}` } : {}),
    ...(opts.content ? { contentHashes: computeContentHashes(v.touched) } : {}),
    // capture(git 너머 행위) — capture.jsonl 레코드 있을 때만. gitVisible = receipt 의 touched∪staged∪untracked 재사용.
    // receiptHash 입력엔 미포함(metadata) → capture 안 쓰면 키 부재·contentHash 불변(기존 사용자 바이트동일).
    ...(() => {
      const git = new Set([...v.touched, ...v.staged, ...v.untracked]);
      const ca = loadCapturedActions(git);
      if (!ca) return {};
      // D4: capture 있으면 대사도 동결(actions 와 동일 패턴·receiptHash 입력 제외).
      const recon = loadReconciliation(git);
      return { actions: ca.actions, actionsSummary: ca.actionsSummary, ...(recon ? { reconciliation: recon } : {}) };
    })(),
    // mcp-tap 관측 요약(§9) — 커서 이후 창에 레코드 있을 때만. receiptHash 입력 제외 → tap 미사용=키 부재·기존 바이트동일.
    ...(() => {
      const t = buildTapSummary();
      return t ? { tapSummary: t } : {};
    })(),
    contentHash: "",
  };
  r.contentHash = receiptHash(r); // 나머지 필드 확정 후 봉인(actions 는 receiptHash 입력에서 제외 — :61 참고).
  return r;
}

function envMdLines(e: Environment): string[] {
  return [
    "## Environment (provenance)",
    `- repoRoot: \`${e.repoRoot ?? "(none)"}\``,
    `- branch: \`${e.branch}\`  headHash: \`${e.headHash}\``,
    `- node: ${e.nodeVersion}  npm: ${e.npmVersion ?? "?"}  git: ${e.gitVersion ?? "?"}`,
    `- os: ${e.os.platform}/${e.os.arch} (${e.os.release})`,
    `- agent-receipt: ${e.agentReceiptVersion}  contractHash: \`${e.contractHash ?? "?"}\`  policyHash: \`${e.policyHash ?? "none"}\``,
    `- provenance: agent=${e.provenance.agent ?? "(미지정)"} model=${e.provenance.model ?? "(미지정)"} (source: ${e.provenance.source})`,
    "",
  ];
}

function policyMdLines(p: PolicyObs | null): string[] {
  if (!p) return ["## Policy (상시규칙)", "- (policy.yaml 없음)", ""];
  const L = ["## Policy (상시규칙 — N8 트립와이어)"];
  L.push(p.forbidAlwaysHits.length ? `- ⛔ forbidAlways: ${p.forbidAlwaysHits.join(", ")}` : "- forbidAlways: (none)");
  if (p.protectAlwaysHits.length) L.push(`- ⚠️ protectAlways: ${p.protectAlwaysHits.join(", ")}`);
  if (p.approvalNeededHits.length) L.push(`- ⚠️ approvalFor: ${p.approvalNeededHits.join(", ")}`);
  L.push("");
  return L;
}

export function toReceiptMd(r: Receipt): string {
  const L: string[] = [];
  L.push(`# Agent Receipt: ${r.contractId}`);
  if (r.title) L.push(`> ${r.title}`);
  // P0 D1·D2: 판정·계약을 최상단 표면화 — 필드 없는(구) 영수증은 기존 출력 바이트동일.
  if (r.verdict) L.push(`> ${renderVerdictLine(r.verdict)}`);
  if (r.contractSnapshot) L.push(`> ${renderContractLine(r.contractSnapshot)}`);
  L.push("");
  L.push(`- ok: **${r.ok ? "PASS ✅" : "FAIL ❌"}**`);
  L.push(`- branch: \`${r.branch.current}\`${r.branch.expected ? ` (expected \`${r.branch.expected}\`)` : ""}`);
  L.push(`- headHash: \`${r.headHash}\``);
  L.push(`- timestamp: ${r.timestamp}`);
  L.push("");
  L.push(`## Changes (touched ${r.touched.length})`);
  for (const f of r.touched) {
    const tag = r.outOfScope.includes(f) ? " — ⚠️ out-of-scope" : r.deniedHits.includes(f) ? " — ⛔ denied" : "";
    L.push(`- \`${f}\`${tag}`);
  }
  if (!r.touched.length) L.push("- (none)");
  L.push("");
  L.push("## Violations");
  if (r.violations.length) for (const v of r.violations) L.push(`- ${v}`);
  else L.push("- (none)");
  L.push("");
  L.push("## Session (baseline)");
  if (!r.session) L.push("- none");
  else L.push(`- applied: ${r.session.applied}${r.session.reason ? ` (${r.session.reason})` : ""}, baselineHead: \`${r.session.baselineHead}\`${r.session.kind ? `, kind: ${r.session.kind}` : ""}${r.session.objective ? `, objective(자가보고): ${r.session.objective}` : ""}`);
  L.push("");
  L.push("## Checks");
  if (r.checks.length) for (const c of r.checks) L.push(`- ${c.name}: ${c.ok ? "OK" : "✗"} (exit ${c.exitCode}, expected ${c.requiredExit})`);
  else L.push("- (none)");
  L.push("");
  const magScope = r.measuredFrom ? `commit ${r.measuredFrom.replace(/^committed:/, "")}..HEAD` : "full working tree vs HEAD";
  L.push(`## Magnitude (${magScope} — git numstat)`);
  L.push(`- files changed: ${r.magnitude.filesChanged}, +${r.magnitude.added} / -${r.magnitude.deleted} lines, new files: ${r.magnitude.newFiles}`);
  L.push("");
  L.push("## Critical paths");
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  if (hit.length) for (const c of hit) L.push(`- ⚠️ \`${c.glob}\`: ${c.touched.join(", ")}`);
  else L.push("- (none touched)");
  L.push("");
  for (const ln of policyMdLines(r.policy)) L.push(ln);
  for (const ln of envMdLines(r.environment)) L.push(ln);
  if (r.contentHashes && r.contentHashes.length) {
    L.push(`## Content hashes (--content — touched ${r.contentHashes.length}, 해시만 저장)`);
    for (const c of r.contentHashes) L.push(`- \`${c.path}\`: ${c.sha256 ?? "(skip — 대용량/삭제)"} (${c.bytes}B)`);
    L.push("");
  }
  if (r.actions && r.actions.length) {
    const s = r.actionsSummary;
    const { notable, mutedCount } = splitActionsForDisplay(r.actions);
    L.push(`## Beyond-git actions (capture — git 가 못 보는 행위 ${r.actions.length}, 주목 ${notable.length})`);
    for (const a of notable) L.push(`- ⚠️ ${a.flag}: \`${a.path ?? a.host ?? ""}\``);
    if (mutedCount) L.push(`- · 그 외 일반 read/command ${mutedCount}건 (기록됨)`);
    if (s) L.push(`- git 가 보는 것: ${s.gitVisible}  ⟷  주목 행위: ${notable.length} (전체 기록 ${s.total})`);
    L.push("> capture 범위 = 마지막 `capture reset` 이후 누적(수동). 값 미저장 — 경로/호스트/분류만.");
    L.push("");
  }
  if (r.reconciliation && r.reconciliation.residuals.length) {
    const rc = r.reconciliation;
    L.push(`## Reconciliation (git 변경 ↔ capture 대사 — 일치 ${rc.matched}, 잔차 ${rc.residuals.length})`);
    for (const res of rc.residuals) L.push(`- ${res.reason === "unexplained" ? "⚠️ 미설명(capture 못 봄)" : "· 읽기/삭제만 관측"}: \`${res.path}\``);
    if (rc.capturedNotInGit) L.push(`- capture write 인데 git 효과 없음: ${rc.capturedNotInGit}건(생성후삭제/임시 등)`);
    L.push("> 대사는 자동 cleared 하지 않음 — 미설명 잔차는 갭으로 남깁니다(거짓 안심 차단).");
    L.push("");
  }
  if (r.tapSummary) {
    const t = r.tapSummary;
    L.push(`## MCP tap (관측 전용 프록시 — 이번 창 호출 ${t.calls} · 레코드 ${t.records})`);
    L.push(`- 서버별: ${Object.entries(t.byServer).map(([k, v]) => `${k}:${v}`).join(" · ") || "(없음)"}`);
    L.push(`- 클래스별: ${Object.entries(t.byClass).map(([k, v]) => `${k}:${v}`).join(" · ") || "(없음)"}`);
    if (t.dropped) L.push(`- ⚠️ dropped:${t.dropped} (기록 큐 포화 자백 — 중계는 무결)`);
    if (t.coverage.missing.length) L.push(`- 창 내 기록 없는 감싼 서버: ${t.coverage.missing.join(", ")} (미사용/중단 구분 불가 — 사실 신호)`);
    if (t.coverage.excluded.length) L.push(`- 선언된 관측 제외: ${t.coverage.excluded.join(", ")} (침묵 없는 제외)`);
    if (t.coverage.unwrapped?.length) L.push(`- 감쌀 수 없던 서버: ${t.coverage.unwrapped.join(", ")} (v1 은 stdio 만 — 커버리지 거짓말 방지 자백)`);
    if (t.coverage.configDrift.length) L.push(`- ⚠️ 설정 드리프트: ${t.coverage.configDrift.join(", ")} (install 시점 sidecar 와 불일치)`);
    if ((t.byClass["fs-write"] ?? 0) > 0 && r.touched.length === 0 && r.untracked.length === 0)
      L.push("- ⚠️ tap fs-write 관측·git 변경 0 — 생성후삭제/ignored/저장소 밖 가능(사실 신호 · tap 은 경로 무관측)");
    L.push("> tap 은 값 미저장(형태·크기·digest) · 증거 등급=controls 위계 C(자가 관측) · 판정(verdict) 입력 아님.");
    L.push("");
  }
  L.push("## Integrity");
  L.push(`- contentHash: \`${r.contentHash}\``);
  L.push("");
  L.push(`> ${LIMIT_NOTE}`);
  L.push("");
  return L.join("\n");
}

// 고객/외주 전달용 Markdown — 내부 violation 상세는 빼고 결과/규모/무결성 요약만.
export function toClientMd(r: Receipt): string {
  const L: string[] = [];
  L.push(`# AI Work Receipt — ${r.contractId}`);
  if (r.title) L.push(`> ${r.title}`);
  L.push("");
  L.push(`- Result: **${r.ok ? "PASS ✅" : "FAIL ❌"}**`);
  L.push(`- Branch: \`${r.branch.current}\`${r.branch.expected ? ` (expected \`${r.branch.expected}\`)` : ""}`);
  L.push(`- Commit (HEAD): \`${r.headHash}\``);
  L.push(`- Files changed: ${r.touched.length}`);
  L.push(`- Magnitude: ${r.magnitude.filesChanged} files, +${r.magnitude.added} / -${r.magnitude.deleted} lines, ${r.magnitude.newFiles} new`);
  const hit = r.criticalPaths.filter((c) => c.touched.length);
  L.push(hit.length ? `- Critical paths touched: ${hit.map((c) => c.glob).join(", ")}` : "- Critical paths: none touched");
  L.push(`- Checks: ${r.checks.length ? r.checks.map((c) => `${c.name} ${c.ok ? "OK" : "✗"}`).join(", ") : "none"}`);
  L.push(`- Environment: node ${r.environment.nodeVersion}, ${r.environment.os.platform}/${r.environment.os.arch}, agent-receipt ${r.environment.agentReceiptVersion}`);
  L.push(`- Provenance: agent=${r.environment.provenance.agent ?? "(unspecified)"}, model=${r.environment.provenance.model ?? "(unspecified)"}`);
  L.push(`- Integrity (contentHash): \`${r.contentHash}\``);
  L.push(`- Generated at: ${r.timestamp}`);
  L.push("");
  L.push("## Reviewer note");
  L.push("> _(reviewer fills in)_");
  L.push("");
  L.push(`> ${LIMIT_NOTE}`);
  L.push("");
  return L.join("\n");
}

export type ReceiptFormat = "json" | "md" | "client-md";

export function renderReceipt(r: Receipt, fmt: ReceiptFormat): string {
  return fmt === "md" ? toReceiptMd(r) : fmt === "client-md" ? toClientMd(r) : JSON.stringify(r, null, 2) + "\n";
}

// ── 쓰기(side-effect): 렌더 + (옵션)redact + 파일 기록. rel 경로와 redact 건수를 반환(exit 없음). ──
export function writeReceiptFile(
  r: Receipt,
  fmt: ReceiptFormat,
  outArg: string | undefined,
  redact: boolean,
): { rel: string; out: string; redactCount: number } {
  let body = renderReceipt(r, fmt);
  let redactCount = 0;
  if (redact) {
    // json 은 구조 인식 redactor(유효 JSON 유지·키 오탐 방지), md/client-md 는 text.
    const red = fmt === "json" ? redactJsonText(body) : redactText(body);
    body = red.text;
    redactCount = red.count;
  }
  const stamp = r.timestamp.replace(/[:.]/g, "-");
  const ext = fmt === "json" ? "json" : "md";
  const rel = outArg ?? join(".agent-guard", "receipts", `receipt-${stamp}.${ext}`);
  const out = isAbsolute(rel) ? rel : join(process.cwd(), rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, body);
  return { rel, out, redactCount };
}

/**
 * `agent-receipt receipt [--format json|md|client-md] [--out <path>] [--redact]`
 * verify(상태) + check(명령) 결과를 .agent-guard/receipts/ 아래 파일로 저장(기본 json). exit = ok ? 0 : 1.
 */
export interface ReceiptOpts {
  content?: boolean; // --content: touched 파일 sha256 기록
  strictRedact?: boolean; // --strict-redact: 강한 비밀 감지 시 파일 쓰기 거부
  agent?: string; // --agent: provenance(명시값)
  model?: string; // --model: provenance(명시값)
  committed?: boolean; // --committed: 커밋-모드(parent..HEAD 측정). post-commit 증거 훅용 — --no-verify 우회에도 생존.
}

export function runReceipt(
  contract: Contract,
  contractPath: string | undefined,
  format: string | undefined,
  outArg: string | undefined,
  redact: boolean = false,
  opts: ReceiptOpts = {},
): never {
  const fmt: ReceiptFormat = format === "md" ? "md" : format === "client-md" ? "client-md" : "json";
  // 커밋-모드(--committed): base = HEAD 부모(머지=first-parent), 루트 커밋이면 빈 트리. 방금 만든 커밋 측정.
  const committedBase = opts.committed ? (g.parentOfHead() ?? g.EMPTY_TREE) : undefined;
  const r = buildReceipt(contract, contractPath, { content: opts.content, agent: opts.agent, model: opts.model, committedBase });
  // strict-redact: 강한 shape 비밀(sk-/ghp_/AKIA/xox/Bearer) 감지 시 파일을 쓰지 않고 거부(exit 2 — council 합의).
  if (opts.strictRedact) {
    const probe = fmt === "json" ? redactJsonText(renderReceipt(r, fmt)) : redactText(renderReceipt(r, fmt));
    if (probe.strong > 0) {
      console.error(`✗ strict-redact: 강한 비밀 패턴 ${probe.strong}건 감지 — receipt 를 쓰지 않습니다. 비밀을 제거 후 다시 실행하세요.`);
      process.exit(2);
    }
  }
  const effectiveRedact = redact || opts.strictRedact === true;
  const { rel, out, redactCount } = writeReceiptFile(r, fmt, outArg, effectiveRedact);
  console.log(`receipt 저장: ${rel} (ok=${r.ok})${effectiveRedact ? ` (redact: ${redactCount}건 가림, best-effort)` : ""}`);
  const rl = relative(join(process.cwd(), ".agent-guard", "receipts"), out);
  if (rl.startsWith("..") || isAbsolute(rl)) {
    console.log("  참고: 기본 위치(.agent-guard/receipts/) 밖이라 다음 verify 가 이 파일을 변경으로 잡을 수 있습니다. 기본 위치 권장.");
  }
  console.log("  → 조회: `agent-receipt receipts` (목록) / `--latest` / `--cat`");
  process.exit(r.ok ? 0 : 1);
}
