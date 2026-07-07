import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { receiptHash, type Receipt } from "./receipt.js";
import { dssePae, type DsseEnvelope } from "./anchor.js";
import { replayVerificationReceipt } from "./vreceipt.js";
import { LIMIT_NOTE } from "./disclosure.js";

// v0.21 결정7 (council 2026-07-07) — verify-proof: "이 증거 묶음 진짜냐"를 한 명령으로.
// 원칙: **신규 검증 프리미티브 0** — receiptHash 재계산 + DSSE(PAE) 서명검증 + rekor sidecar 형식 + vreceipt replay 의 합성.
// 정직: 전부 **오프라인**(네트워크 0) — Rekor 는 sidecar 존재/형식만 확인하고, 공개 로그 실확인은 사람이 링크 클릭.

export type ProofCheckId =
  | "receipt-parse" // receipt.json 존재·JSON 파싱
  | "receipt-hash" // contentHash 재계산 일치(git-사실 부분집합·타임스탬프 제외 설계)
  | "dsse-signature" // anchor.dsse.json 서명이 public.pem 으로 검증됨
  | "dsse-subject" // DSSE payload 의 subject.digest == receipt contentHash
  | "rekor-sidecar" // anchor.rekor.json 형식(uuid·verifyUrl) — 존재 확인만(실확인=링크)
  | "evidence-replay"; // evidence/*.json 각각 봉인 재계산(오프라인)

export interface ProofCheck {
  id: ProofCheckId;
  status: "ok" | "fail" | "skip";
  detail: string; // 사람말 — 무엇을 확인했고 무엇이 틀렸나
}

// 실패 원인 enum → 사람말(고정 매핑 — SRE 수용기준).
const FAIL_WORDS: Record<ProofCheckId, string> = {
  "receipt-parse": "receipt.json 을 읽거나 파싱할 수 없음 — 번들이 손상됐거나 불완전합니다.",
  "receipt-hash": "영수증 내용이 봉인(contentHash)과 다릅니다 — 생성 후 누군가 receipt.json 을 고쳤습니다(변조 신호).",
  "dsse-signature": "서명이 public.pem 으로 검증되지 않습니다 — 봉투(anchor.dsse.json)나 키가 바뀌었습니다.",
  "dsse-subject": "서명된 Statement 가 가리키는 영수증 해시가 receipt.json 과 다릅니다 — 봉투와 영수증이 서로 다른 물건입니다.",
  "rekor-sidecar": "anchor.rekor.json 형식이 올바르지 않습니다(uuid/verifyUrl 없음).",
  "evidence-replay": "evidence 영수증의 봉인 재계산이 실패했습니다 — 해당 파일이 생성 후 변경됐습니다.",
};

export function verifyProofBundle(dir: string): { checks: ProofCheck[]; ok: boolean } | null {
  const p = (f: string): string => join(dir, f);
  if (!existsSync(p("receipt.json"))) return null; // 입력 오류(번들 아님) — CLI 가 exit 2
  const checks: ProofCheck[] = [];
  const push = (id: ProofCheckId, ok: boolean | null, okDetail: string, skipDetail = ""): void => {
    if (ok === null) checks.push({ id, status: "skip", detail: skipDetail });
    else checks.push({ id, status: ok ? "ok" : "fail", detail: ok ? okDetail : FAIL_WORDS[id] });
  };

  // 1) receipt 파싱 + 봉인 재계산
  let receipt: Receipt | null = null;
  try {
    receipt = JSON.parse(readFileSync(p("receipt.json"), "utf8")) as Receipt;
  } catch {
    receipt = null;
  }
  push("receipt-parse", !!receipt, "receipt.json 파싱 OK");
  const statedHash = receipt?.contentHash ?? "";
  if (receipt) {
    let ok = false;
    try {
      ok = receiptHash(receipt) === statedHash;
    } catch {
      ok = false;
    }
    push("receipt-hash", ok, "봉인 재계산 일치 — 영수증 본문은 생성 시점 그대로");
  } else {
    push("receipt-hash", null, "", "receipt 파싱 실패로 생략");
  }

  // 2) DSSE 서명 + subject 대조(둘 다 있을 때만 — 없으면 skip 이 정직)
  const hasDsse = existsSync(p("anchor.dsse.json"));
  const hasPem = existsSync(p("public.pem"));
  if (hasDsse && hasPem) {
    let sigOk = false;
    let subjOk = false;
    try {
      const env = JSON.parse(readFileSync(p("anchor.dsse.json"), "utf8")) as DsseEnvelope;
      const pub = createPublicKey(readFileSync(p("public.pem"), "utf8"));
      const payload = Buffer.from(env.payload, "base64");
      const pae = dssePae(env.payloadType, payload);
      sigOk = env.signatures.some((s) => {
        try {
          return edVerify(null, pae, pub, Buffer.from(s.sig, "base64"));
        } catch {
          return false;
        }
      });
      const st = JSON.parse(payload.toString("utf8")) as { subject?: Array<{ digest?: { sha256?: string } }> };
      const digest = st.subject?.[0]?.digest?.sha256 ?? "";
      subjOk = !!digest && `sha256:${digest}` === statedHash;
    } catch {
      sigOk = false;
      subjOk = false;
    }
    push("dsse-signature", sigOk, "DSSE 서명 검증 OK(자기관리 키 — 무결성+키 소유·신원 아님)");
    push("dsse-subject", subjOk, "서명된 Statement 가 이 영수증(contentHash)을 가리킴");
  } else {
    push("dsse-signature", null, "", hasDsse ? "public.pem 없음 — 서명 검증 생략" : "anchor.dsse.json 없음 — 서명 생략");
    push("dsse-subject", null, "", "서명 생략과 동일 사유");
  }

  // 3) Rekor sidecar 형식(존재만·네트워크 0)
  if (existsSync(p("anchor.rekor.json"))) {
    let ok = false;
    let url = "";
    try {
      const a = JSON.parse(readFileSync(p("anchor.rekor.json"), "utf8")) as { uuid?: string; verifyUrl?: string };
      ok = typeof a.uuid === "string" && a.uuid.length >= 40 && typeof a.verifyUrl === "string";
      url = a.verifyUrl ?? "";
    } catch {
      ok = false;
    }
    push("rekor-sidecar", ok, `제3자 등록 기록 있음 — 실확인은 브라우저: ${url} (이 명령은 네트워크 0)`);
  } else {
    push("rekor-sidecar", null, "", "anchor.rekor.json 없음 — 제3자 봉인은 이 번들에 포함되지 않음");
  }

  // 4) evidence/*.json 오프라인 replay
  const evDir = p("evidence");
  if (existsSync(evDir)) {
    const files = readdirSync(evDir).filter((f) => f.endsWith(".json"));
    let bad = 0;
    for (const f of files) {
      try {
        const vr = JSON.parse(readFileSync(join(evDir, f), "utf8")) as Record<string, unknown>;
        const rr = replayVerificationReceipt(vr, {});
        if (!rr.contentHashOk || !rr.receiptIdOk) bad++;
      } catch {
        bad++;
      }
    }
    push("evidence-replay", bad === 0, `evidence ${files.length}건 봉인 재계산 전부 일치`, "");
    if (bad > 0) checks[checks.length - 1].detail += ` (실패 ${bad}/${files.length}건)`;
  } else {
    push("evidence-replay", null, "", "evidence/ 없음 — 검증영수증은 이 번들에 포함되지 않음");
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { checks, ok };
}

const MARK = { ok: "✅", fail: "❌", skip: "· " } as const;

/** `agent-receipt verify-proof <bundle-dir>` — 받은 증거 묶음을 한 번에 검증(오프라인). exit 0=전부 통과 / 1=검증 실패 / 2=입력 오류. */
export function runVerifyProof(dirArg: string | undefined, cwd: string = process.cwd()): never {
  if (!dirArg || dirArg.startsWith("--")) {
    console.error("verify-proof: 사용법 — agent-receipt verify-proof <proof-bundle-dir> (share-proof --bundle 산출 폴더)");
    process.exit(2);
  }
  const dir = isAbsolute(dirArg) ? dirArg : join(cwd, dirArg);
  if (!existsSync(dir)) {
    console.error(`verify-proof: 폴더 없음: ${dirArg}`);
    process.exit(2);
  }
  const res = verifyProofBundle(dir);
  if (!res) {
    console.error(`verify-proof: receipt.json 이 없습니다 — proof bundle(share-proof --bundle 산출) 폴더를 주세요: ${dirArg}`);
    process.exit(2);
  }
  console.log("");
  console.log("─".repeat(56));
  console.log(`agent-receipt verify-proof: ${dirArg}  (오프라인 — 네트워크 0)`);
  console.log("─".repeat(56));
  for (const c of res.checks) console.log(`${MARK[c.status]} ${c.id}: ${c.detail}`);
  console.log("─".repeat(56));
  console.log(res.ok ? "결과: 통과 — 이 번들은 생성 시점 그대로입니다(변조 신호 없음)." : "결과: 실패 — 위 ❌ 항목이 변조/불일치 신호입니다.");
  console.log("  " + LIMIT_NOTE);
  console.log("");
  process.exit(res.ok ? 0 : 1);
}
