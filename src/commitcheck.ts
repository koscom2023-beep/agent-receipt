import type { Contract } from "./schema.js";
import { runVerify, runCheck } from "./checks.js";
import { buildReceipt, type Receipt } from "./receipt.js";
import { loadPolicySafe, policyObservations, policyPath } from "./policy.js";
import { touchedFull } from "./evidence.js";
import { listReceipts, parseReceiptJson, hasApproval } from "./receiptStore.js";
import { hashFileOrNull } from "./environment.js";
import { LIMIT_NOTE } from "./disclosure.js";

const line = "─".repeat(56);

interface Gate {
  label: string;
  ok: boolean;
  detail: string;
}

// 사람이 커밋 메시지에 직접 붙일 트레일러(값/diff 없이 해시·경로 메타만). 자동 삽입 안 함.
export function buildTrailer(
  contentHash: string,
  receiptRel: string | null,
  contractHash: string | null,
  policyHash: string | null,
): string[] {
  const L = [`Agent-Receipt: ${contentHash}`];
  if (receiptRel) L.push(`Agent-Receipt-Path: ${receiptRel}`);
  L.push(`Agent-Contract: ${contractHash ?? "none"}`);
  L.push(`Agent-Policy: ${policyHash ?? "none"}`);
  return L;
}

/** `agent-receipt trailer` — 커밋 트레일러만 출력(사람이 붙임). 민감정보/diff/내용 없음. */
export function runTrailer(contract: Contract, contractPath: string | undefined, cwd: string = process.cwd()): never {
  const fresh = buildReceipt(contract, contractPath);
  const receipts = listReceipts(cwd).filter((r) => r.name.endsWith(".json"));
  const latest = receipts[0]?.rel ?? null;
  const { policy } = loadPolicySafe(cwd);
  const polHash = policy ? hashFileOrNull(policyPath(cwd)) : null;
  const trailer = buildTrailer(fresh.contentHash, latest, hashFileOrNull(contractPath), polHash);
  for (const ln of trailer) console.log(ln);
  process.exit(0);
}

/**
 * `agent-receipt commit-check` — 커밋 직전 확인. 자동 commit/revert 하지 않는다(확인·출력만).
 * 게이트: verify PASS · check PASS · 최신 receipt 가 현재 변경과 일치 · policy(require·forbid·approval) 충족.
 * exit 0(통과) / 1(게이트 실패) / 2(env).
 */
export interface CommitCheckEval {
  gates: Gate[];
  advisories: string[];
  allOk: boolean;
  fresh: Receipt;
  latestRel: string | null;
  policyHash: string | null;
}

// 비-exit core: commit-check 게이트 평가(출력/exit 없음). finish 가 재사용. runCommitCheck 출력은 불변.
export function evaluateCommitCheck(
  contract: Contract,
  contractPath: string | undefined,
  cwd: string = process.cwd(),
): CommitCheckEval {
  const v = runVerify(contract);
  const chk = runCheck(contract);
  const { policy, error } = loadPolicySafe(cwd);
  const fresh = buildReceipt(contract, contractPath);

  const receipts = listReceipts(cwd).filter((r) => r.name.endsWith(".json"));
  const latestEntry = receipts[0] ?? null;
  const latest = latestEntry ? parseReceiptJson(latestEntry.abs) : null;
  const receiptMatches = !!latest && latest.contentHash === fresh.contentHash;
  const approvalOnLatest = latestEntry ? hasApproval(latestEntry.abs) : false;

  const obs = policy ? policyObservations(policy, touchedFull()) : null;

  const gates: Gate[] = [];
  const advisories: string[] = [];

  gates.push({ label: "verify 상태", ok: v.ok, detail: v.ok ? "PASS" : `위반 ${v.violations.length}건` });
  gates.push({
    label: "check 명령",
    ok: chk.ok,
    detail: chk.commands.length ? (chk.ok ? "PASS" : `실패 ${chk.commands.filter((c) => !c.ok).length}건`) : "명령 없음(통과 처리)",
  });

  // contract denied(금지 경로) — verify 가 이미 위반에 포함하지만, 게이트로 명시.
  gates.push({
    label: "금지 경로(denied)",
    ok: v.deniedHits.length === 0,
    detail: v.deniedHits.length ? `${v.deniedHits.join(", ")}` : "없음",
  });

  if (error) advisories.push(`policy.yaml 무시됨: ${error.split("\n")[0]}`);

  if (policy && obs) {
    gates.push({
      label: "상시금지(forbidAlways)",
      ok: obs.forbidAlwaysHits.length === 0,
      detail: obs.forbidAlwaysHits.length ? obs.forbidAlwaysHits.join(", ") : "없음",
    });
    if (policy.requireReceipt) {
      gates.push({
        label: "receipt 필요(requireReceipt)",
        ok: receiptMatches,
        detail: receiptMatches ? "최신 receipt 가 현재 변경과 일치" : "현재 변경과 일치하는 receipt 없음 — `receipt` 먼저",
      });
    }
    if (policy.requireCheck) {
      gates.push({
        label: "check 필요(requireCheck)",
        ok: chk.commands.length > 0 && chk.ok,
        detail: chk.commands.length ? (chk.ok ? "PASS" : "실패") : "required_checks.commands 비어 있음",
      });
    }
    if (obs.approvalNeededHits.length) {
      gates.push({
        label: "승인 필요(requireApprovalFor)",
        ok: approvalOnLatest,
        detail: approvalOnLatest
          ? `승인됨 — ${obs.approvalNeededHits.join(", ")}`
          : `승인 없음 — ${obs.approvalNeededHits.join(", ")} (\`approve --receipt <latest>\`)`,
      });
    }
    if (policy.maxUntrackedAllowed !== undefined) {
      const n = v.untracked.length;
      gates.push({
        label: `untracked ≤ ${policy.maxUntrackedAllowed}`,
        ok: n <= policy.maxUntrackedAllowed,
        detail: `현재 ${n}건`,
      });
    }
    if (policy.requireClaims) {
      advisories.push("requireClaims=true — `agent-receipt claims --file <claim.json>` 로 AI 완료보고를 직접 대조했는지 확인하세요(이 명령은 claim 파일을 받지 않음).");
    }
    if (obs.protectAlwaysHits.length) {
      advisories.push(`protectAlways 경로 변경: ${obs.protectAlwaysHits.join(", ")} (차단 아님 — 검토 권장)`);
    }
  }

  const allOk = gates.every((g) => g.ok);
  const policyHash = policy ? hashFileOrNull(policyPath(cwd)) : null;
  return { gates, advisories, allOk, fresh, latestRel: latestEntry?.rel ?? null, policyHash };
}

export function runCommitCheck(contract: Contract, contractPath: string | undefined, cwd: string = process.cwd()): never {
  const e = evaluateCommitCheck(contract, contractPath, cwd);

  console.log("");
  console.log(line);
  console.log(`agent-receipt commit-check: ${contract.id}  (커밋 직전 — 자동 commit/revert 안 함)`);
  console.log(line);
  for (const g of e.gates) console.log(`  ${g.ok ? "✓" : "✗"} ${g.label}: ${g.detail}`);
  if (e.advisories.length) {
    console.log("");
    console.log("참고(advisory):");
    for (const a of e.advisories) console.log(`  · ${a}`);
  }
  console.log(line);
  if (e.allOk) {
    console.log("결과: OK ✅ — 사람이 직접 stage/commit 하세요. 아래 트레일러를 커밋 메시지에 붙일 수 있습니다(선택):");
    console.log("");
    for (const ln of buildTrailer(e.fresh.contentHash, e.latestRel, hashFileOrNull(contractPath), e.policyHash)) {
      console.log(`  ${ln}`);
    }
  } else {
    console.log(`결과: 차단 ❌ — 게이트 ${e.gates.filter((g) => !g.ok).length}건 미충족. (자동 revert 안 함 — 위 항목을 해결 후 다시.)`);
  }
  console.log(line);
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(e.allOk ? 0 : 1);
}
