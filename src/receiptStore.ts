import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Receipt } from "./receipt.js";

// receipt 저장 위치(고정) — receipt.ts 의 기본 --out 과 동일. verify 는 이 디렉터리를 제외한다.
export const RECEIPTS_REL = join(".agent-guard", "receipts");

export function receiptsDirAbs(cwd: string): string {
  return join(cwd, RECEIPTS_REL);
}

export type ReceiptEntry = { name: string; abs: string; rel: string };

// receipt 파일만 나열한다(sidecar .sig.json / .approval.json 은 제외).
// 기본 receipt 파일명은 ISO timestamp 기반 → 이름 내림차순 = 최신 우선(mtime 비의존, 결정론적).
export function listReceipts(cwd: string): ReceiptEntry[] {
  const dir = receiptsDirAbs(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(
    (f) =>
      (f.endsWith(".json") || f.endsWith(".md")) &&
      !f.endsWith(".sig.json") &&
      !f.endsWith(".approval.json") &&
      !f.endsWith(".rekor.json") &&
      !f.endsWith(".completion.json"), // P0-4: Work Receipt 의 완료 검증 사이드카 — Work Receipt 아님(share/inbox 가 오인하면 안 됨)
  );
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return files.map((f) => ({ name: f, abs: join(dir, f), rel: join(RECEIPTS_REL, f) }));
}

export type ReceiptJson = {
  ok?: boolean;
  contractId?: string;
  title?: string;
  timestamp?: string;
  contentHash?: string;
  headHash?: string;
  branch?: { current?: string; expected?: string | null };
  magnitude?: { filesChanged?: number; added?: number; deleted?: number; newFiles?: number };
  criticalPaths?: Array<{ glob?: string; touched?: string[] }>;
  touched?: string[];
  checks?: Array<{ name?: string; ok?: boolean }>;
};

/**
 * 저장 receipt 적재 SSOT (13차 council) — explicit `--receipt` 또는 최신 `.json` 해석 → parse → *영수증 형식* 검증.
 * 형식 = ok:boolean + checks/criticalPaths/touched 배열 존재(verify --json 같은 부분 JSON 은 거부 → 렌더 크래시 방지).
 * 실패 시 cmd 접두 stderr + exit 2. 반환 {abs, receipt}(abs 는 `.rekor.json` sidecar 조회용). controls/risk/share-proof 공용.
 */
export function loadSavedReceipt(receiptArg: string | undefined, cmd: string, cwd: string = process.cwd()): { abs: string; receipt: Receipt } {
  let abs: string;
  if (receiptArg) {
    abs = isAbsolute(receiptArg) ? receiptArg : join(cwd, receiptArg);
    if (!existsSync(abs)) {
      console.error(`${cmd}: receipt 파일 없음: ${receiptArg}`);
      process.exit(2);
    }
  } else {
    const latest = listReceipts(cwd).find((e) => e.name.endsWith(".json"));
    if (!latest) {
      console.error(`${cmd}: 저장된 receipt 없음 — 먼저 \`agent-receipt done\`/\`receipt\` 실행하거나 --receipt <경로> 지정.`);
      process.exit(2);
    }
    abs = latest.abs;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    console.error(`${cmd}: receipt 파싱 실패(JSON 아님): ${abs}`);
    process.exit(2);
  }
  // 14차 council(무결점): consumer(controls/risk/share-proof)가 deref 하는 필드를 *전부* 검증 → 형식 통과 후 deref 크래시 제거.
  //   buildReceipt 산출 영수증은 전부 통과(회귀 0). verify --json 출력 같은 부분 JSON 만 clean exit 2.
  const o = parsed as Partial<Receipt> | null;
  const arr = (v: unknown): v is unknown[] => Array.isArray(v);
  const str = (v: unknown): v is string => typeof v === "string";
  const valid =
    !!o &&
    typeof o === "object" &&
    typeof o.ok === "boolean" &&
    arr(o.touched) &&
    arr(o.staged) &&
    arr(o.untracked) &&
    arr(o.outOfScope) &&
    arr(o.deniedHits) &&
    arr(o.checks) &&
    arr(o.criticalPaths) &&
    o.criticalPaths.every((c) => !!c && typeof c === "object" && Array.isArray((c as { touched?: unknown }).touched)) &&
    !!o.branch &&
    typeof o.branch === "object" &&
    str((o.branch as { current?: unknown }).current) &&
    !!o.magnitude &&
    typeof o.magnitude === "object" &&
    str(o.contentHash) &&
    str(o.headHash) &&
    str(o.timestamp);
  if (!valid) {
    console.error(`${cmd}: receipt 형식이 아님 — 저장된 영수증이 필요합니다(verify --json 출력 아님): ${abs}`);
    process.exit(2);
  }
  return { abs, receipt: o as Receipt };
}

export function parseReceiptJson(abs: string): ReceiptJson | null {
  try {
    const o = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    return o && typeof o === "object" ? (o as ReceiptJson) : null;
  } catch {
    return null;
  }
}

export function criticalTouchedCount(o: ReceiptJson): number {
  if (!Array.isArray(o.criticalPaths)) return 0;
  return o.criticalPaths.reduce((n, c) => n + (Array.isArray(c?.touched) ? c.touched!.length : 0), 0);
}

// ── sidecar (approval / signature) 헬퍼 — commit-check·audit-pack·ledger·incident 공용 ──
export function approvalPath(receiptAbs: string): string {
  return receiptAbs + ".approval.json";
}
export function signaturePath(receiptAbs: string): string {
  return receiptAbs + ".sig.json";
}
// 사이드카 status 판독(SSOT) — status 없는 구파일 = approved(하위호환)·rejected/needs-review 는 승인 아님·손상 JSON = null(가짜 상태 금지).
// 0.20 review reject/note 가 같은 .approval.json 을 확장하므로, "파일 존재=승인" 판정은 반려를 승인으로 둔갑시킨다(감사 결함) — 반드시 status 를 본다.
export type ApprovalSidecarStatus = "approved" | "rejected" | "needs-review";
export function approvalStatusFor(receiptAbs: string): ApprovalSidecarStatus | null {
  const p = approvalPath(receiptAbs);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return a.status === "rejected" || a.status === "needs-review" || a.status === "approved"
      ? (a.status as ApprovalSidecarStatus)
      : "approved";
  } catch {
    return null;
  }
}
export function hasApproval(receiptAbs: string): boolean {
  return approvalStatusFor(receiptAbs) === "approved"; // 존재≠승인 — 반려/보류 사이드카는 승인 아님
}
export function hasSignature(receiptAbs: string): boolean {
  return existsSync(signaturePath(receiptAbs));
}
// approve 는 receipt 당 sidecar 1개를 덮어쓴다 → count 는 0/1.
export function approvalsCountFor(receiptAbs: string): number {
  return hasApproval(receiptAbs) ? 1 : 0;
}

// ── Rekor 앵커 sidecar (Stage 1b) — `anchor --upload` 등록 성공 시 영수증 옆에 기록, share-proof 가 검증 링크로 임베드 ──
export type RekorAnchor = {
  uuid: string;
  logIndex: number | null;
  verifyUrl: string; // 사람이 누르는 공개 검증 페이지(search.sigstore.dev)
  apiUrl: string; // 기계 검증용 Rekor 엔트리 API
};
export function rekorAnchorPath(receiptAbs: string): string {
  return receiptAbs + ".rekor.json";
}
export function hasRekorAnchor(receiptAbs: string): boolean {
  return existsSync(rekorAnchorPath(receiptAbs));
}
/** sidecar 가 있으면 파싱해서 반환, 없거나 깨졌으면 null(= share-proof 가 앵커 섹션 생략 → 기존과 바이트 동일). */
export function loadRekorAnchor(receiptAbs: string): RekorAnchor | null {
  const p = rekorAnchorPath(receiptAbs);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, "utf8")) as RekorAnchor;
    if (a && typeof a.uuid === "string" && typeof a.verifyUrl === "string") return a;
  } catch {
    /* 깨진 sidecar → 앵커 없음으로 취급(증거를 위조하지 않음) */
  }
  return null;
}
