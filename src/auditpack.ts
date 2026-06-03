import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import type { Contract } from "./schema.js";
import { buildReceipt, renderReceipt } from "./receipt.js";
import { loadPolicySafe, policyPath } from "./policy.js";
import {
  listReceipts,
  hasApproval,
  hasSignature,
  approvalPath,
  signaturePath,
  approvalsCountFor,
} from "./receiptStore.js";
import { redactText } from "./redact.js";
import { appendLedger, ledgerEntryFromReceipt, LEDGER_REL } from "./ledger.js";
import { LIMIT_NOTE } from "./disclosure.js";

const PACKS_REL = join(".agent-guard", "audit-packs");

// claim ↔ receipt 간단 대조(비-exit). claims.ts 의 전체 출력 대신 audit-pack/done 내장용 요약.
export function claimVerify(claimRaw: unknown, touched: string[], untracked: string[], denied: string[]): {
  ok: boolean;
  fields: Array<{ field: string; hidden: string[]; extra: string[]; ok: boolean }>;
} {
  const clean = (p: string): string => p.replace(/^\.\//, "");
  const set = (a: unknown): Set<string> =>
    new Set(Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").map(clean) : []);
  const cmp = (field: string, ai: unknown, git: string[]) => {
    const a = set(ai);
    const g = new Set(git.map(clean));
    const hidden = [...g].filter((x) => !a.has(x)).sort();
    const extra = [...a].filter((x) => !g.has(x)).sort();
    return { field, hidden, extra, ok: hidden.length === 0 && extra.length === 0 };
  };
  const c = (claimRaw && typeof claimRaw === "object" ? claimRaw : {}) as Record<string, unknown>;
  const fields: Array<{ field: string; hidden: string[]; extra: string[]; ok: boolean }> = [];
  if (c["changedFiles"] !== undefined) fields.push(cmp("changedFiles", c["changedFiles"], touched));
  if (c["newFiles"] !== undefined) fields.push(cmp("newFiles", c["newFiles"], untracked));
  if (c["deniedHits"] !== undefined) fields.push(cmp("deniedHits", c["deniedHits"], denied));
  return { ok: fields.every((f) => f.ok), fields };
}

/**
 * `agent-receipt audit-pack [--out <dir>] [--claim <path>] [--redact] [--ledger]`
 * 작업 증거를 한 폴더로 묶는다(복사·요약 — 재계산 아님). "위조 불가 증명"이 아니라 "감사 검토용 증거 묶음"이다.
 */
export function runAuditPack(
  contract: Contract,
  contractPath: string | undefined,
  outArg: string | undefined,
  claimArg: string | undefined,
  redact: boolean,
  toLedger: boolean,
  cwd: string = process.cwd(),
): never {
  const r = buildReceipt(contract, contractPath);
  const stamp = r.timestamp.replace(/[:.]/g, "-");
  const relDir = outArg ?? join(PACKS_REL, stamp);
  const dir = isAbsolute(relDir) ? relDir : join(cwd, relDir);
  mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  const maybeRedact = (s: string): string => (redact ? redactText(s).text : s);
  const writePack = (name: string, body: string): void => {
    writeFileSync(join(dir, name), body);
    files.push(name);
  };

  // 1) receipt.json + summary.md (fresh — 재계산 아님: 같은 git 상태면 같은 contentHash)
  writePack("receipt.json", maybeRedact(renderReceipt(r, "json")));
  writePack("summary.md", maybeRedact(renderReceipt(r, "md")));

  // 2) contract 사본
  if (contractPath && existsSync(contractPath)) {
    const cname = "contract" + (extname(contractPath) || ".yaml");
    writePack(cname, maybeRedact(readFileSync(contractPath, "utf8")));
  }

  // 3) policy 사본(있으면)
  const { policy } = loadPolicySafe(cwd);
  if (policy && existsSync(policyPath(cwd))) {
    writePack("policy.yaml", maybeRedact(readFileSync(policyPath(cwd), "utf8")));
  }

  // 4) claim 사본 + claim-verify(있으면)
  let claimMatched: boolean | null = null;
  if (claimArg) {
    const cpath = isAbsolute(claimArg) ? claimArg : join(cwd, claimArg);
    if (existsSync(cpath)) {
      const raw = readFileSync(cpath, "utf8");
      writePack("claim.json", maybeRedact(raw));
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* 손상 claim → verify 생략 */
      }
      if (parsed) {
        const cv = claimVerify(parsed, r.touched, r.untracked, r.deniedHits);
        claimMatched = cv.ok;
        writePack("claim-verify.json", JSON.stringify({ ok: cv.ok, fields: cv.fields, note: "AI 주장 ↔ git 실측 대조" }, null, 2) + "\n");
      }
    }
  }

  // 5) 최신 저장 receipt 의 approval/signature sidecar 복사(있으면 — 승인/서명 증거)
  const latest = listReceipts(cwd).filter((e) => e.name.endsWith(".json"))[0] ?? null;
  let approvalsCount = 0;
  if (latest) {
    if (hasApproval(latest.abs)) {
      copyFileSync(approvalPath(latest.abs), join(dir, "approval.json"));
      files.push("approval.json");
    }
    if (hasSignature(latest.abs)) {
      copyFileSync(signaturePath(latest.abs), join(dir, "signature.sig.json"));
      files.push("signature.sig.json");
    }
    approvalsCount = approvalsCountFor(latest.abs);
  }

  // 6) environment.json
  writePack("environment.json", JSON.stringify(r.environment, null, 2) + "\n");

  // 7) manifest.json (마지막 — files 목록 확정 후)
  const manifest = {
    kind: "agent-receipt.audit-pack",
    generatedAt: r.timestamp,
    contractId: r.contractId,
    headHash: r.headHash,
    branch: r.branch.current,
    ok: r.ok,
    contentHash: r.contentHash,
    redacted: redact,
    files: [...files, "manifest.json"].sort(),
    disclosure: LIMIT_NOTE,
    note: "감사 검토용 증거 묶음 — git 기준 재검증(replay) 가능한 작업 기록. '위조 불가 증명'이 아니라 변조를 알아챌 수 있는(tamper-evident) 로컬 기록.",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  if (toLedger) {
    appendLedger(ledgerEntryFromReceipt(r, join(relDir, "receipt.json"), approvalsCount, claimMatched), cwd);
  }

  console.log(`audit-pack 생성: ${relDir}/ (${manifest.files.length} files, ok=${r.ok}${redact ? ", redacted" : ""})`);
  console.log(`  재검증: agent-receipt replay --pack ${relDir}`);
  if (toLedger) console.log(`  원장 적립: ${LEDGER_REL}`);
  console.log("  " + LIMIT_NOTE);
  process.exit(0);
}
