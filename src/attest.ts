import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Receipt } from "./receipt.js";
import { approvalsCountFor } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";

// in-toto Statement 스타일(표준형 증명 "초안"). 실제 SLSA level 주장/완전 준수 단정 금지.
// 로컬 자가서명은 "위조 불가"가 아니라 "변조를 알아챌 수 있는(tamper-evident) 출처 기록"이다.
const PREDICATE_TYPE = "https://promptia-labs.dev/agent-receipt/ai-work/v0.1";

function readReceipt(p: string): Receipt | null {
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Receipt;
  } catch {
    return null;
  }
}

export interface InTotoStatement {
  _type: string;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: string;
  predicate: Record<string, unknown>;
}

/**
 * 순수함수: Receipt(+approvals) → in-toto Statement v1(표준형 증명 초안).
 * Stage 0(6차 council): 기존 형태 보존·발명 0·새 producer 신축 금지. DSSE 봉투/Sigstore 서명은 Stage 1.
 * capture actions 는 *있을 때만* 포함(checks↔approvals 사이) → capture 없는 영수증은 기존 출력 바이트동일(s6-15 골든 보존).
 */
export function buildAiWorkStatement(r: Receipt, approvals: number): InTotoStatement {
  const sha = (r.contentHash ?? "").replace(/^sha256:/, "");
  const env = r.environment ?? ({} as Receipt["environment"]);
  const crit = Array.isArray(r.criticalPaths) ? r.criticalPaths.reduce((n, c) => n + (c.touched?.length ?? 0), 0) : 0;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: "ai-work-receipt", digest: { sha256: sha } },
      { name: "git-commit", digest: { gitCommit: r.headHash } },
    ],
    predicateType: PREDICATE_TYPE,
    predicate: {
      tool: "agent-receipt",
      toolVersion: env.agentReceiptVersion ?? null,
      contractId: r.contractId ?? null,
      contractHash: env.contractHash ?? null,
      policyHash: env.policyHash ?? null,
      branch: r.branch?.current ?? null,
      headHash: r.headHash ?? null,
      ok: r.ok ?? null,
      changes: {
        touched: Array.isArray(r.touched) ? r.touched.length : 0,
        outOfScope: r.outOfScope ?? [],
        deniedHits: r.deniedHits ?? [],
        criticalTouched: crit,
        magnitude: r.magnitude ?? null,
      },
      checks: Array.isArray(r.checks) ? r.checks.map((c) => ({ name: c.name, ok: c.ok })) : [],
      // capture(git 너머 행위) — 있을 때만 포함(byte-invariant). 영수증과 동일 키. 우리 고유가치를 증명에 봉인.
      ...(r.actions && r.actions.length ? { actions: r.actions, actionsSummary: r.actionsSummary } : {}),
      approvals,
      generatedAt: r.timestamp ?? null,
      disclosure: LIMIT_NOTE,
      note: "in-toto style 표준형 증명 초안 — 실제 SLSA level 주장이 아니며 표준 완전 준수를 단정하지 않습니다. 로컬 자가서명은 위조 불가가 아니라 변조를 알아챌 수 있는(tamper-evident) 출처 기록입니다.",
    },
  };
}

/**
 * `agent-receipt attest --receipt <path>` | `--pack <dir>` — in-toto style Statement 를 stdout 에 출력.
 *  전송/서명 자동화 없음. exit 0 / 2.
 */
export function runAttest(receiptArg: string | undefined, packArg: string | undefined, cwd: string = process.cwd()): never {
  let receiptPath: string | null = null;
  if (receiptArg) receiptPath = isAbsolute(receiptArg) ? receiptArg : join(cwd, receiptArg);
  else if (packArg) {
    const d = isAbsolute(packArg) ? packArg : join(cwd, packArg);
    receiptPath = join(d, "receipt.json");
  }
  if (!receiptPath) {
    console.error("attest: --receipt <path> 또는 --pack <dir> 가 필요합니다.");
    process.exit(2);
  }
  if (!existsSync(receiptPath)) {
    console.error(`attest: receipt 없음: ${receiptPath}`);
    process.exit(2);
  }
  const r = readReceipt(receiptPath);
  if (!r || typeof r.contentHash !== "string") {
    console.error("attest: json receipt 가 필요합니다(파싱 실패 또는 contentHash 없음).");
    process.exit(2);
  }

  const approvals = approvalsCountFor(receiptPath); // <receipt>.approval.json sidecar 기준
  const statement = buildAiWorkStatement(r, approvals);
  process.stdout.write(JSON.stringify(statement, null, 2) + "\n");
  process.stderr.write("note: in-toto style 초안을 stdout 으로만 출력했습니다 — 전송/등록/자동서명 없음.\n");
  process.exit(0);
}
