import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    (f) => (f.endsWith(".json") || f.endsWith(".md")) && !f.endsWith(".sig.json") && !f.endsWith(".approval.json"),
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
