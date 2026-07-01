import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const line = "─".repeat(56);

// ── Evidence Graph — 조회/색인 레이어 (L6 v1) ──
// 쌓인 Verification Receipt 를 commit/input/model/receiptId 로 질의한다(읽기전용·중립).
// 정직: v1 은 조회/색인이지 receipt 간 관계(edge-DAG)는 아직 아니다 — 그건 L6 후속.
// 집계는 pass/fail 카운트(중립·점수/판단 아님·insights 범주).

export interface VRRow {
  receiptId: string;
  subject: string;
  verdict: string;
  surface: string;
  model: string | null;
  commit: string | null;
  inputSha: string | null;
  file: string;
}

// 디렉터리의 verification-receipt JSON 만 로드(다른 파일·손상 파일 skip).
export function loadReceipts(dir: string): VRRow[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: VRRow[] = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (!r || r.kind !== "verification-receipt") continue;
      const prov = ((r.provenance as { reported?: Record<string, unknown> } | undefined)?.reported) ?? {};
      const input = r.input as { sha256?: unknown } | undefined;
      out.push({
        receiptId: typeof r.receiptId === "string" ? r.receiptId : "",
        subject: typeof r.subject === "string" ? r.subject : "",
        verdict: typeof r.verdict === "string" ? r.verdict : "",
        surface: typeof r.surface === "string" ? r.surface : "",
        model: typeof prov.model === "string" ? prov.model : null,
        commit: typeof prov.commit === "string" ? prov.commit : null,
        inputSha: typeof input?.sha256 === "string" ? input.sha256 : null,
        file: f,
      });
    } catch {
      /* 손상 파일 skip */
    }
  }
  return out;
}

export interface GraphFilters {
  commit?: string;
  input?: string;
  model?: string;
  receiptId?: string;
}

export function queryReceipts(rows: VRRow[], f: GraphFilters): VRRow[] {
  return rows.filter(
    (r) =>
      (!f.commit || r.commit === f.commit) &&
      (!f.input || r.inputSha === f.input) &&
      (!f.model || r.model === f.model) &&
      (!f.receiptId || r.receiptId === f.receiptId),
  );
}

/**
 * `agent-receipt graph query --dir <d> [--commit <h>] [--input <sha>] [--model <m>] [--receipt-id <id>]`
 *  쌓인 Verification Receipt 를 질의. 읽기전용·중립 카운트. exit 0.
 */
export function runGraphQuery(dirArg: string | undefined, f: GraphFilters): never {
  const dir = dirArg
    ? isAbsolute(dirArg)
      ? dirArg
      : join(process.cwd(), dirArg)
    : join(process.cwd(), ".agent-guard", "vreceipts");
  const all = loadReceipts(dir);
  const rows = queryReceipts(all, f);

  console.log("");
  console.log(line);
  console.log(`Evidence Graph 조회: ${dir}  (총 ${all.length}건 중 ${rows.length}건 일치)`);
  console.log(line);
  for (const r of rows) {
    console.log(`  ${r.verdict === "pass" ? "✓" : "✗"} ${r.receiptId.slice(0, 12)}… [${r.surface}] ${r.subject.slice(0, 40)}`);
    console.log(`      model=${r.model ?? "-"} · commit=${r.commit ? r.commit.slice(0, 8) : "-"} · input=${r.inputSha ? r.inputSha.slice(0, 8) : "-"}`);
  }
  if (!rows.length) console.log("  (일치 영수증 없음)");

  // 중립 집계(카운트·점수/판단 아님).
  const pass = rows.filter((r) => r.verdict === "pass").length;
  const byModel: Record<string, { pass: number; fail: number }> = {};
  for (const r of rows) {
    const m = r.model ?? "(unknown)";
    (byModel[m] ??= { pass: 0, fail: 0 });
    if (r.verdict === "pass") byModel[m].pass++;
    else byModel[m].fail++;
  }
  console.log(line);
  console.log(`집계: pass ${pass} · fail ${rows.length - pass}  (중립 카운트 · 점수/판단 아님)`);
  for (const [m, c] of Object.entries(byModel)) console.log(`  model ${m}: pass ${c.pass} · fail ${c.fail}`);
  console.log(line);
  console.log("");
  process.exit(0);
}
