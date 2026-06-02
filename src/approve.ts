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

/**
 * `agent-receipt approve --receipt <path> [--note "<text>"]` — local approval(SaaS workflow 의 로컬판).
 * sidecar <receipt>.approval.json 생성. git commit/네트워크 없음. exit 0(성공)/2(usage·파일 없음).
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
  const o = rpath.endsWith(".json") ? parseReceiptJson(rpath) : null;
  const payload = {
    approver: approver(),
    approvedAt: new Date().toISOString(),
    receipt: basename(rpath),
    contentHash: o?.contentHash ?? null,
    note: note ?? "",
  };
  const sidecar = rpath + ".approval.json";
  writeFileSync(sidecar, JSON.stringify(payload, null, 2) + "\n");
  console.log(`승인 기록: ${rel(sidecar, cwd)} (approver: ${payload.approver})`);
  console.log("  목록: agent-receipt approvals   (git commit/전송은 하지 않습니다.)");
  process.exit(0);
}

/** `agent-receipt approvals` — receipts/ 의 .approval.json 목록(read-only). exit 0. */
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
    console.log("  승인 없음 — 'agent-receipt approve --receipt <path>' 로 기록하세요.");
  } else {
    for (const f of files) {
      let a: { approver?: unknown; approvedAt?: unknown; receipt?: unknown; note?: unknown } = {};
      try {
        a = JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        /* 손상 sidecar */
      }
      console.log(`  ${String(a.receipt ?? f)}  ✓ ${String(a.approver ?? "?")}  ${String(a.approvedAt ?? "?")}${a.note ? `  — ${String(a.note)}` : ""}`);
    }
  }
  console.log(line);
  console.log("");
  process.exit(0);
}
