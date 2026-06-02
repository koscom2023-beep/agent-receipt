import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// receipt 저장 위치(고정) — receipt.ts 의 기본 --out 과 동일. verify 는 이 디렉터리를 제외한다.
const RECEIPTS_REL = join(".agent-guard", "receipts");
const line = "─".repeat(56);

type Entry = { name: string; abs: string; rel: string };

function receiptsDirAbs(cwd: string): string {
  return join(cwd, RECEIPTS_REL);
}

// 기본 receipt 파일명은 ISO timestamp 기반(receipt-<ts>.json) → 이름 내림차순 = 최신 우선.
// mtime 비의존(결정론적). 사용자가 임의 이름을 써도 best-effort 정렬.
function listReceipts(cwd: string): Entry[] {
  const dir = receiptsDirAbs(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") || f.endsWith(".md"));
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return files.map((f) => ({ name: f, abs: join(dir, f), rel: join(RECEIPTS_REL, f) }));
}

type JsonSummary = {
  ok?: boolean;
  contractId?: string;
  timestamp?: string;
  contentHash?: string;
  magnitude?: { filesChanged?: number; added?: number; deleted?: number; newFiles?: number };
  criticalPaths?: Array<{ touched?: string[] }>;
};

function parseJson(abs: string): JsonSummary | null {
  try {
    const o = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    return o && typeof o === "object" ? (o as JsonSummary) : null;
  } catch {
    return null;
  }
}

function criticalTouched(o: JsonSummary): number {
  if (!Array.isArray(o.criticalPaths)) return 0;
  return o.criticalPaths.reduce((n, c) => n + (Array.isArray(c?.touched) ? c.touched!.length : 0), 0);
}

function okStr(ok: boolean | undefined): string {
  return ok === true ? "PASS ✅" : ok === false ? "FAIL ❌" : "?";
}

function listLine(e: Entry): string {
  if (e.name.endsWith(".json")) {
    const o = parseJson(e.abs);
    if (o) return `${e.name}  [${okStr(o.ok)}] ${o.contractId ?? "?"}  ${o.timestamp ?? "?"}  critical:${criticalTouched(o)}`;
    return `${e.name}  (json 파싱 실패)`;
  }
  return `${e.name}  (md — 내용은 --cat)`;
}

export type ReceiptsMode = "list" | "latest" | "cat" | "dir";

/**
 * `agent-receipt receipts [--latest|--cat|--dir]`
 * .agent-guard/receipts/ 아래 저장된 receipt 를 찾는다(read-only). 계약/ git 불필요.
 *  - (없음) 최근 10개 목록 / --latest 최신 요약 / --cat 최신 내용 / --dir 디렉터리 경로
 * receipt 가 없는 건 오류가 아님 → 더 안전한 exit 0 + 생성 안내.
 */
export function runReceipts(mode: ReceiptsMode, cwd: string = process.cwd()): never {
  if (mode === "dir") {
    console.log(receiptsDirAbs(cwd)); // 스크립트용 — 절대경로 그대로.
    process.exit(0);
  }

  const entries = listReceipts(cwd);

  if (!entries.length) {
    console.log("");
    console.log(`receipt 없음 (${RECEIPTS_REL} 비어있음/없음).`);
    console.log("  → agent-receipt receipt   (verify+check 결과를 저장)");
    console.log("");
    process.exit(0); // read-only 조회 — 없음은 실패 아님(exit 0).
  }

  if (mode === "cat") {
    process.stdout.write(readFileSync(entries[0].abs, "utf8")); // 최신 내용 그대로.
    process.exit(0);
  }

  if (mode === "latest") {
    const e = entries[0];
    console.log("");
    console.log(line);
    console.log("agent-receipt receipts --latest");
    console.log(line);
    console.log(`  파일        : ${e.rel}`);
    if (e.name.endsWith(".json")) {
      const o = parseJson(e.abs);
      if (o) {
        console.log(`  ok          : ${okStr(o.ok)}`);
        console.log(`  contractId  : ${o.contractId ?? "?"}`);
        console.log(`  timestamp   : ${o.timestamp ?? "?"}`);
        console.log(`  contentHash : ${o.contentHash ?? "?"}`);
        if (o.magnitude) console.log(`  magnitude   : files ${o.magnitude.filesChanged ?? 0}, +${o.magnitude.added ?? 0}/-${o.magnitude.deleted ?? 0}, new ${o.magnitude.newFiles ?? 0}`);
        console.log(`  critical    : ${criticalTouched(o)} touched`);
      } else {
        console.log("  (json 파싱 실패 — 내용 직접 확인: agent-receipt receipts --cat)");
      }
    } else {
      console.log("  (md receipt — 내용은 agent-receipt receipts --cat)");
    }
    console.log(line);
    console.log("  내용: agent-receipt receipts --cat   대조: agent-receipt claims --file <claim.json>");
    console.log("");
    process.exit(0);
  }

  // mode === "list"
  console.log("");
  console.log(line);
  console.log(`agent-receipt receipts  (${RECEIPTS_REL}, 총 ${entries.length}개 — 최신순)`);
  console.log(line);
  for (const e of entries.slice(0, 10)) console.log(`  ${listLine(e)}`);
  if (entries.length > 10) console.log(`  … 외 ${entries.length - 10}개`);
  console.log(line);
  console.log("  최신 요약: --latest   최신 내용: --cat   디렉터리: --dir");
  console.log("");
  process.exit(0);
}
