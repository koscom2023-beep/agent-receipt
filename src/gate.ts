import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { formatGuardDeny, inferHookVendor, type HookVendor } from "./hook-deny.js";

// R9: 검사 실패 = 행위 중단 배선. verification-receipt 의 verdict 를 *집행*한다(fail→차단).
//
// 정직(회의): 이건 경로기반 예방 가드(guard.ts·fail-open)와 다른 계층 — 사용자가 "이 검증이 통과해야 진행"을
//   **명시 배선한 곳에서만** 도는 opt-in enforcement 다(기본 아님·기본 가드의 fail-open 불변).
//   gate 자체 오류(파일없음/파싱실패)는 block 이 아니라 exit 2(도구 오류 ≠ 검증 실패)로 fail-open 정신을 일부 유지.
// deny 출력은 기존 formatGuardDeny/inferHookVendor 재사용(벤더별 deny·SSOT).

interface VReceiptShape {
  kind?: unknown;
  verdict?: unknown;
  surface?: unknown;
  receiptId?: unknown;
  subject?: unknown;
}

export interface GateDecision {
  block: boolean;
  reason: string;
}

// 순수 판정: verdict === "fail" 이면 행위 차단. (그 외=허용 — abstain/pass 는 진행)
export function gateDecision(r: VReceiptShape): GateDecision {
  const verdict = typeof r.verdict === "string" ? r.verdict : "unknown";
  const surface = typeof r.surface === "string" ? r.surface : "verification";
  const subject = typeof r.subject === "string" ? r.subject : "(subject 없음)";
  if (verdict === "fail") {
    return {
      block: true,
      reason: `agent-receipt gate: ${surface} 검증 실패(verdict=fail) — "${subject}". 근거가 출처/재계산과 불일치합니다. 이 행위를 중단하고 검증 실패를 보고하세요(같은 행위 재시도 금지). 해제: 검증을 통과시키거나 gate 배선을 제거.`,
    };
  }
  return { block: false, reason: `agent-receipt gate: ${surface} 검증 ${verdict} — 진행 허용.` };
}

/**
 * `agent-receipt gate --receipt <verification-receipt.json> [--hook] [--vendor claude|cursor]`
 *  검증 실패를 행위 중단으로 집행. 두 모드:
 *   - 기본(CI/행위 게이트): fail → stderr 사유 + exit 1(파이프라인/행위 중단) · 그 외 → exit 0.
 *   - `--hook`(PreToolUse): fail → 벤더별 deny JSON stdout + exit 0(도구 실행 전 차단) · 그 외 → 무출력 허용.
 *  gate 자체 오류(파일없음/파싱실패/비-영수증) = exit 2(non-block·도구 오류).
 */
export function runGate(receiptArg: string | undefined, opts: { hook?: boolean; vendor?: string } = {}): never {
  if (!receiptArg) {
    console.error("gate: --receipt <verification-receipt.json> 가 필요합니다.");
    process.exit(2);
  }
  const p = isAbsolute(receiptArg) ? receiptArg : join(process.cwd(), receiptArg);
  if (!existsSync(p)) {
    console.error(`gate: 파일 없음: ${receiptArg} (도구 오류 — 검증 실패 아님·non-block)`);
    process.exit(2);
  }
  let receipt: VReceiptShape;
  try {
    receipt = JSON.parse(readFileSync(p, "utf8")) as VReceiptShape;
  } catch {
    console.error(`gate: JSON 파싱 실패: ${receiptArg} (도구 오류·non-block)`);
    process.exit(2);
  }
  if (receipt.kind !== "verification-receipt") {
    console.error("gate: verification-receipt 가 아닙니다(kind='verification-receipt'). research/council/bench --out 산출을 주세요.");
    process.exit(2);
  }
  const d = gateDecision(receipt);

  if (opts.hook) {
    // PreToolUse 훅 모드: 실패면 벤더별 deny JSON 방출(도구 실행 전 차단)·통과면 무출력(허용).
    if (!d.block) process.exit(0);
    let vendor: HookVendor = opts.vendor === "cursor" ? "cursor" : "claude";
    if (!opts.vendor && !process.stdin.isTTY) {
      try {
        const raw = readFileSync(0, "utf8").replace(/^﻿/, "");
        if (raw.trim()) vendor = inferHookVendor(JSON.parse(raw));
      } catch {
        /* 페이로드 없으면 기본 claude */
      }
    }
    process.stdout.write(formatGuardDeny(vendor, d.reason) + "\n");
    process.exit(0);
  }

  // CI/행위 게이트 모드: 실패=exit 1(중단)·그 외=exit 0.
  if (d.block) {
    console.error(d.reason);
    process.exit(1);
  }
  console.log(d.reason);
  process.exit(0);
}
