import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import * as g from "./git.js";
import { parseReceiptJson, receiptsDirAbs, RECEIPTS_REL } from "./receiptStore.js";

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}
function rel(p: string, cwd: string): string {
  const r = relative(cwd, p);
  return r.startsWith("..") || isAbsolute(r) ? p : r;
}
function approver(): string {
  const u = g.gitUser();
  if (u.name && u.email) return `${u.name} <${u.email}>`;
  if (u.name) return u.name;
  if (u.email) return u.email;
  return "unknown";
}

// ── 배치A-2 (council 2026-07-07) — review 사이드카 정식화 ──
// receipt 를 "읽는 문서"에서 "검토가 끝난 문서"로: approve/reject/note 가 같은 사이드카(<receipt>.approval.json)에
// status 를 기록한다. hosted-호환 4필드 동결 = status / reviewer / reviewedAt / note (구키 approver/approvedAt 는
// 하위호환으로 병기·구파일에 status 없음 = approved 로 간주). 정직: reviewer=git user 자가보고(위조 가능·권위 아님) —
// 표기는 "review recorded"(기록)이지 승인 권위가 아니다. DA 지적 수용.
export type ReviewStatus = "approved" | "rejected" | "needs-review";
export interface ReviewRecord {
  status: ReviewStatus;
  reviewer: string;
  reviewedAt: string;
  note: string;
}

function sidecarPath(rpath: string): string {
  return rpath + ".approval.json";
}
function writeSidecar(rpath: string, status: ReviewStatus, note: string): ReviewRecord & { receipt: string } {
  const o = rpath.endsWith(".json") ? parseReceiptJson(rpath) : null;
  const who = approver();
  const at = new Date().toISOString();
  const payload = {
    // hosted-호환 4필드(동결)
    status,
    reviewer: who,
    reviewedAt: at,
    note,
    // 구키(하위호환 병기 — 기존 approvals/뷰어가 읽음)
    approver: who,
    approvedAt: at,
    receipt: basename(rpath),
    contentHash: o?.contentHash ?? null,
  };
  writeFileSync(sidecarPath(rpath), JSON.stringify(payload, null, 2) + "\n");
  return { status, reviewer: who, reviewedAt: at, note, receipt: basename(rpath) };
}

/** 사이드카 읽기 — 없으면 null(미검토). status 없는 구파일 = approved(하위호환). inbox/share-proof 가 사용. */
export function reviewStatusFor(receiptAbs: string): ReviewRecord | null {
  const p = sidecarPath(receiptAbs);
  if (!existsSync(p)) return null;
  try {
    const a = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    const status: ReviewStatus =
      a.status === "rejected" || a.status === "needs-review" || a.status === "approved" ? (a.status as ReviewStatus) : "approved";
    return {
      status,
      reviewer: String(a.reviewer ?? a.approver ?? "unknown"),
      reviewedAt: String(a.reviewedAt ?? a.approvedAt ?? ""),
      note: String(a.note ?? ""),
    };
  } catch {
    return null; // 손상 사이드카 = 미검토 취급(가짜 상태 금지)
  }
}

/**
 * `agent-receipt review approve|reject|note --receipt <path> [--note "<text>"]` (배치A-2)
 *  approve/reject = status 기록 · note = 메모만(기존 status 유지·없으면 needs-review). exit 0/2.
 */
export function runReviewMark(sub: string, receiptArg: string | undefined, note: string | undefined, cwd: string = process.cwd()): never {
  if (!receiptArg) {
    console.error(`review ${sub}: --receipt <path> 가 필요합니다.`);
    process.exit(2);
  }
  const rpath = abs(receiptArg, cwd);
  if (!existsSync(rpath)) {
    console.error(`review ${sub}: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  let status: ReviewStatus;
  if (sub === "approve") status = "approved";
  else if (sub === "reject") status = "rejected";
  else status = reviewStatusFor(rpath)?.status ?? "needs-review"; // note: 상태 보존·최초면 needs-review
  const rec = writeSidecar(rpath, status, note ?? (sub === "note" ? "" : reviewStatusFor(rpath)?.note ?? ""));
  console.log(`review 기록: ${rel(sidecarPath(rpath), cwd)}`);
  console.log(`  status: ${rec.status} · reviewer: ${rec.reviewer} (자가보고 — 권위 아님·기록)`);
  console.log("  표시: inbox 배지 · share-proof 'Review recorded' 줄 · 목록: agent-receipt approvals");
  process.exit(0);
}

/**
 * `agent-receipt approve --receipt <path> [--note "<text>"]` — local approval(SaaS workflow 의 로컬판).
 * 배치A-2 이후 = `review approve` 와 동일 사이드카(status 포함). 기존 사용자 표면 유지.
 */
export function runApprove(receiptArg: string | undefined, note: string | undefined, cwd: string = process.cwd()): never {
  if (!receiptArg) {
    console.error("approve: --receipt <path> 가 필요합니다.");
    process.exit(2);
  }
  const rpath = abs(receiptArg, cwd);
  if (!existsSync(rpath)) {
    console.error(`approve: receipt 파일 없음: ${receiptArg}`);
    process.exit(2);
  }
  const rec = writeSidecar(rpath, "approved", note ?? "");
  console.log(`승인 기록: ${rel(sidecarPath(rpath), cwd)} (approver: ${rec.reviewer})`);
  console.log("  목록: agent-receipt approvals   (git commit/전송은 하지 않습니다.)");
  process.exit(0);
}

/** `agent-receipt approvals` — receipts/ 의 .approval.json 목록(read-only·status 표기). exit 0. */
export function runApprovals(cwd: string = process.cwd()): never {
  const line = "─".repeat(56);
  const dir = receiptsDirAbs(cwd);
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".approval.json"))
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    : [];
  console.log("");
  console.log(line);
  console.log(`agent-receipt approvals  (${RECEIPTS_REL})`);
  console.log(line);
  if (!files.length) {
    console.log("  검토 기록 없음 — 'agent-receipt review approve|reject|note --receipt <path>' 로 기록하세요.");
  } else {
    for (const f of files) {
      let a: { approver?: unknown; approvedAt?: unknown; receipt?: unknown; note?: unknown; status?: unknown } = {};
      try {
        a = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        /* 손상 sidecar */
      }
      const st = a.status === "rejected" ? "✗ rejected" : a.status === "needs-review" ? "◌ needs-review" : "✓ approved"; // 구파일=approved
      console.log(`  ${String(a.receipt ?? f)}  ${st}  ${String(a.approver ?? "?")}  ${String(a.approvedAt ?? "?")}${a.note ? `  — ${String(a.note)}` : ""}`);
    }
  }
  console.log(line);
  console.log("  status/reviewer 는 자가보고 기록(권위 아님) — 사이드카는 로컬 파일·전송 0.");
  console.log("");
  process.exit(0);
}
