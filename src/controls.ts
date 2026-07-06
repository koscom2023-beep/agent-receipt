import { loadRekorAnchor, loadSavedReceipt } from "./receiptStore.js";
import { LIMIT_NOTE } from "./disclosure.js";
import { redactText, redactJsonText } from "./redact.js";
import type { Receipt } from "./receipt.js";

// ── 규제 매핑 (8차 council) — 읽기전용 투영: 저장 receipt 신호 → *관련 통제 증거*(준수 아님) ──
// 정직 SSOT: LIMIT_NOTE 승계 · 동사 'evidence relevant to/supports'만('compliant with/satisfies/meets' 금지)
//   · confidence(EU/SOC2=confirmed·ISO 42001=likely·원문확인) · 신호별 doesNotProve · blanket 'consult your assessor'.
// 통제 ID 출처=2026-06-30 정찰(자유검증분만). receipt 미변경·해시 미입력 → 골든143 구조적 byte-invariant.
// registry=데이터(코어 if문에 통제ID 박지 않음·범용 원칙). 과대매핑 금지: ISO A.5/A.7/A.2·EU Art13/15·SOC2 CC1~5 미등록.

export const CONTROL_REGISTRY_SOURCE = "recon 2026-06-30 — free-verifiable only (EU AI Act·SOC 2 TSC confirmed; ISO/IEC 42001 paywalled → likely)";

type Confidence = "confirmed" | "likely";
export interface ControlRef {
  framework: string;
  id: string;
  title: string;
  confidence: Confidence;
}
export interface RegistryEntry {
  signal: string;
  label: string;
  controls: ControlRef[];
  doesNotProve: string;
}

// ── 증거 신뢰도 위계(11차 council·감사 증거 위계 AS 1105/ISA 500 관점) — controls(감사인용) 면에만 노출 ──
// A 외부·독립 > B git 실측(에이전트 주장과 독립) > C capture 자기보고(에이전트 런타임 훅). self-report(note/source/claim)=advisory·PASS/FAIL 입력 아님.
export type EvidenceTier = "A" | "B" | "C";
const SIGNAL_TIER: Record<string, EvidenceTier> = {
  secretFilesRead: "C",
  externalCalls: "C",
  createdThenDeleted: "C",
  deniedHits: "B",
  requiredChecks: "B",
  criticalPaths: "B",
  auditLogIntegrity: "B",
  rekorAnchor: "A",
};
export function tierOf(signal: string): EvidenceTier {
  return SIGNAL_TIER[signal] ?? "C";
}
const TIER_DESC: Record<EvidenceTier, string> = {
  A: "A 외부·독립(Rekor 공개 투명성 로그·제3자 봉인)",
  B: "B git 실측(에이전트 주장과 독립·우리가 직접 관측)",
  C: "C capture 자기보고(에이전트 런타임 훅 기록·자기검토 한계)",
};

const ISO_NOTE = "ISO/IEC 42001 IDs are 'likely' — verify the exact sub-control number/title against the purchased ISO/IEC 42001:2023 text.";

// 활성 신호별 통제 '가족'. 관계는 항상 'evidence relevant to'(준수 아님).
export const CONTROL_REGISTRY: RegistryEntry[] = [
  {
    signal: "secretFilesRead",
    label: "Agent read secret-shaped file path(s)",
    controls: [
      { framework: "SOC 2 TSC", id: "CC6.1", title: "Logical access controls over protected information assets", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring for anomalies", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "Detected by path *name* only — does not prove the file held secrets, that anything leaked, or that access controls worked (records, does not block).",
  },
  {
    signal: "externalCalls",
    label: "Agent made external network call(s)",
    controls: [
      { framework: "SOC 2 TSC", id: "CC6.6", title: "Protection against threats outside system boundaries", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC6.7", title: "Restriction of information transmission/movement", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring for anomalies", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "Detected from command text only — does not see OS-level traffic and does not prove exfiltration.",
  },
  {
    signal: "createdThenDeleted",
    label: "Agent created-then-deleted file(s) (anti-forensic anomaly)",
    controls: [
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring for anomalies", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "A trace-cleanup signal — does not prove malicious intent.",
  },
  {
    signal: "deniedHits",
    label: "Change touched a contract-denied path",
    controls: [
      { framework: "SOC 2 TSC", id: "CC8.1", title: "Change management — authorize/test/approve changes", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring for anomalies", confidence: "confirmed" },
    ],
    doesNotProve: "Evidence of deviation from a *self-declared* scope — does not prove the change was authorized (the contract is self-declared, not independently approved).",
  },
  {
    signal: "requiredChecks",
    label: "Declared required checks ran as a pre-commit gate",
    controls: [
      { framework: "SOC 2 TSC", id: "CC8.1", title: "Change management — tested/approved before implementation", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.1", title: "Detection of config changes that introduce vulnerabilities", confidence: "confirmed" },
    ],
    doesNotProve: "Evidence that declared checks ran — does not prove the checks were adequate or sufficient.",
  },
  {
    signal: "criticalPaths",
    label: "High-risk path(s) identified as touched",
    controls: [
      { framework: "SOC 2 TSC", id: "CC8.1", title: "Change management — high-risk change identification", confidence: "confirmed" },
    ],
    doesNotProve: "Flags that a high-risk path was *touched* — touching it is not itself a problem or a leak.",
  },
  {
    signal: "auditLogIntegrity",
    label: "Receipt + hash-chained logs (tamper-evident)",
    controls: [
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring / log integrity", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.3", title: "Evaluation of security events", confidence: "confirmed" },
      { framework: "EU AI Act", id: "Article 12", title: "Record-keeping — automatic event logs", confidence: "confirmed" },
      { framework: "EU AI Act", id: "Article 19", title: "Automatically generated logs — provider retention (>= 6 months)", confidence: "confirmed" },
      { framework: "EU AI Act", id: "Article 26(6)", title: "Deployer log retention (>= 6 months)", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "tamper-evident (detects mid-stream edit/deletion) — NOT non-forgeable (a local file can be regenerated wholesale). Retention period (>= 6 months) is an operational policy, not a tool feature. EU AI Act Articles apply to high-risk AI systems.",
  },
];

// Rekor 앵커가 붙은 영수증에서만 추가되는 격상 엔트리.
export const ANCHOR_ENTRY: RegistryEntry = {
  signal: "rekorAnchor",
  label: "Receipt anchored to the public Rekor transparency log",
  controls: [
    { framework: "EU AI Act", id: "Article 12/19", title: "Record-keeping / log integrity — third-party time & existence seal", confidence: "confirmed" },
    { framework: "SOC 2 TSC", id: "CC7.2", title: "Log integrity — independently verifiable", confidence: "confirmed" },
  ],
  doesNotProve: "A third party sealed that this receipt existed at this time — NOT a keyless identity proof.",
};

// ── R5: 검증 능력 → 규제 조항 크로스워크 (Work Receipt 신호와 별개·framework-agnostic·영수증 불필요) ──
// 관계는 항상 'evidence relevant to'(준수 아님). confidence=조항 인용 정확도(실존)이지 만족이 아니다.
// SoT: EU AI Act(Reg 2024/1689) 공개 조문·SOC 2 TSC 공개·ISO/IEC 42001 = likely(원문 대조 필요·ISO_NOTE).
export const CROSSWALK_SOURCE = "verification capabilities → clauses · EU AI Act(2024/1689)·SOC 2 TSC confirmed; ISO/IEC 42001 likely(paywalled)";
export const VERIFICATION_CROSSWALK: RegistryEntry[] = [
  {
    signal: "deterministicVerification",
    label: "결정론·재현가능 근거 검사 15종 — 같은 입력→같은 판정(LLM 판단 0)",
    controls: [
      { framework: "EU AI Act", id: "Article 15", title: "Accuracy, robustness and cybersecurity", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC4.1", title: "Ongoing/separate evaluations of controls", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.4", title: "AI system verification and validation", confidence: "likely" },
    ],
    doesNotProve: "Verifies that stated evidence is grounded/recomputable — does NOT establish the AI system's overall accuracy or that its conclusions are correct. Evidence relevant to an accuracy assessment, not a compliance claim.",
  },
  {
    signal: "evidenceGrading",
    label: "증거 등급 A(재계산)/B(대조)/C(형식) + 보류(abstain) — R2",
    controls: [
      { framework: "EU AI Act", id: "Article 15", title: "Accuracy, robustness and cybersecurity", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC4.1", title: "Ongoing/separate evaluations of controls", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.4", title: "AI system verification and validation", confidence: "likely" },
    ],
    doesNotProve: "Grade reflects the STRENGTH of the check (recompute vs compare vs form), not real-world correctness. 'Abstain' marks the unverifiable, not the false.",
  },
  {
    signal: "recordKeepingReceipt",
    label: "봉인 Verification Receipt — 결정론 receiptId + 변조탐지 contentHash",
    controls: [
      { framework: "EU AI Act", id: "Article 12", title: "Record-keeping — automatic event logs", confidence: "confirmed" },
      { framework: "EU AI Act", id: "Article 19", title: "Automatically generated logs — provider retention (>= 6 months)", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring / log integrity", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "A local receipt is tamper-evident, not non-forgeable (can be regenerated wholesale). Retention (>= 6 months) is operational policy, not a tool feature.",
  },
  {
    signal: "transparencyLog",
    label: "Merkle 투명로그(RFC6962) — 포함증명 + 일관성증명(포크 탐지)·R3",
    controls: [
      { framework: "EU AI Act", id: "Article 12", title: "Record-keeping — automatic event logs", confidence: "confirmed" },
      { framework: "EU AI Act", id: "Article 19", title: "Automatically generated logs — integrity/retention", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "Log integrity — independently verifiable", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "Consistency proofs detect a fork between two PUBLISHED roots. Without a public log operator + gossip this is a transparency data structure, not a live transparency service.",
  },
  {
    signal: "provenanceTiering",
    label: "provenance 계층화 — verified(실측) vs reported(자가보고) 분리",
    controls: [
      { framework: "EU AI Act", id: "Article 13", title: "Transparency and provision of information to deployers", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.4", title: "AI system verification and validation", confidence: "likely" },
    ],
    doesNotProve: "'reported' provenance is self-asserted and unproven. Separation prevents self-report being laundered as verified fact — it does NOT prove the reported model/prompt was actually used.",
  },
  {
    signal: "attestationPredicate",
    label: "in-toto claim-verification/v1 predicate — 표준 공급망 증명·R4",
    controls: [
      { framework: "EU AI Act", id: "Article 12", title: "Record-keeping — automatic event logs", confidence: "confirmed" },
      { framework: "SOC 2 TSC", id: "CC7.2", title: "System monitoring / log integrity", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.8", title: "AI system recording of event logs", confidence: "likely" },
    ],
    doesNotProve: "predicateType is an interop type name, not a hosted registry. Local self-signing is tamper-evident, not non-forgeable — strong third-party assurance is delegated to Rekor.",
  },
  {
    signal: "humanCheckable",
    label: "주장 단위 판정 + 근거로 AI 출력을 사람이 검증 가능(LLM 심판 아님)",
    controls: [
      { framework: "EU AI Act", id: "Article 14", title: "Human oversight", confidence: "confirmed" },
      { framework: "ISO/IEC 42001", id: "A.6.2.4", title: "AI system verification and validation", confidence: "likely" },
    ],
    doesNotProve: "Surfaces per-claim evidence for a human to judge — does not make the human decision or guarantee oversight is exercised.",
  },
];

export function renderCrosswalkMd(): string {
  const L: string[] = [];
  L.push("# 검증 능력 → 규제 조항 크로스워크 (agent-receipt)");
  L.push("");
  L.push("> **관계는 'evidence relevant to' 이지 준수(compliance)가 아니다.** 각 검증 능력이 어느 조항의 *증거로 관련*되는지 보여줄 뿐, 규정 충족을 주장하지 않는다 — 감사인/평가자 판단이 필요하다.");
  L.push(`> ${ISO_NOTE}`);
  L.push("");
  for (const e of VERIFICATION_CROSSWALK) {
    L.push(`## ${e.label}`);
    L.push(`\`${e.signal}\``);
    L.push("");
    L.push("| Framework | Clause | Title | Citation |");
    L.push("|-----------|--------|-------|----------|");
    for (const c of e.controls) L.push(`| ${c.framework} | ${c.id} | ${c.title} | ${c.confidence} |`);
    L.push("");
    L.push(`- **does NOT prove:** ${e.doesNotProve}`);
    L.push("");
  }
  L.push(`_source: ${CROSSWALK_SOURCE}_`);
  return L.join("\n");
}
export function renderCrosswalkJson(): string {
  return JSON.stringify(
    { kind: "verification-control-crosswalk", relationship: "evidence-relevant-to (NOT compliance)", isoNote: ISO_NOTE, source: CROSSWALK_SOURCE, entries: VERIFICATION_CROSSWALK },
    null,
    2,
  );
}
export function runCrosswalk(format: string | undefined): never {
  process.stdout.write((format === "json" ? renderCrosswalkJson() : renderCrosswalkMd()) + "\n");
  process.exit(0);
}

export interface ControlMapResult {
  source: string;
  noVerification: boolean;
  entries: RegistryEntry[];
}

/** 순수: receipt 신호(+Rekor 앵커 유무) → 활성 통제 매핑. 활성 신호만 포함. checks 0 = noVerification. */
export function buildControlMap(r: Receipt, hasAnchor: boolean): ControlMapResult {
  const sum = r.actionsSummary;
  const pos = (n: number | undefined) => typeof n === "number" && n > 0;
  const active: RegistryEntry[] = [];
  for (const e of CONTROL_REGISTRY) {
    if (e.signal === "secretFilesRead" && !pos(sum?.secretFilesRead)) continue;
    if (e.signal === "externalCalls" && !pos(sum?.externalCalls)) continue;
    if (e.signal === "createdThenDeleted" && !pos(sum?.createdThenDeleted)) continue;
    if (e.signal === "deniedHits" && r.deniedHits.length === 0) continue;
    if (e.signal === "requiredChecks" && r.checks.length === 0) continue;
    if (e.signal === "criticalPaths" && !r.criticalPaths.some((c) => c.touched.length)) continue;
    // auditLogIntegrity 는 항상 활성(영수증 자체가 무결성 해시를 가짐).
    active.push(e);
  }
  if (hasAnchor) active.push(ANCHOR_ENTRY);
  return { source: CONTROL_REGISTRY_SOURCE, noVerification: r.checks.length === 0, entries: active };
}

/** 순수: 통제 매핑 → 사람용 Markdown. 동사는 'evidence relevant to' 만(준수 단정 금지). */
export function renderControlMd(r: Receipt, hasAnchor: boolean): string {
  const m = buildControlMap(r, hasAnchor);
  const L: string[] = [];
  L.push(`# Control evidence map — ${r.contractId}${r.title ? ` (${r.title})` : ""}`);
  L.push("");
  L.push("> **This is evidence *relevant to* the controls below — NOT a compliance assessment.** It does not certify, satisfy, or prove compliance with any framework. Consult your assessor/auditor; the determination is theirs.");
  L.push(`> ${ISO_NOTE}`);
  L.push(`> ${LIMIT_NOTE}`);
  L.push(`> Source: ${m.source}`);
  L.push("");
  L.push("> **Evidence reliability tier** (audit-evidence hierarchy, PCAOB AS 1105 / ISA 500 lens): **A** external·independent (Rekor) > **B** git-measured (independent of the agent's claims) > **C** capture self-reported (agent runtime hook). Self-report (note/source/claim) is advisory — never a PASS/FAIL input.");
  L.push("");
  if (m.noVerification) {
    L.push("- ⚠️ No required checks were declared — **no verification is claimed** (a checks-empty receipt is a vacuous PASS).");
    L.push("");
  }
  for (const e of m.entries) {
    L.push(`## ${e.label}  _[tier ${tierOf(e.signal)} — ${TIER_DESC[tierOf(e.signal)]}]_`);
    L.push("Evidence relevant to:");
    for (const c of e.controls) {
      const conf = c.confidence === "likely" ? " _(likely — verify against original)_" : "";
      L.push(`- **${c.framework} ${c.id}** — ${c.title}${conf}`);
    }
    L.push(`- _Does not prove:_ ${e.doesNotProve}`);
    L.push("");
  }
  L.push("---");
  L.push("Wording is deliberately limited to *evidence relevant to / supports*; this map never asserts certification or fulfillment of any control.");
  return L.join("\n");
}

/** 순수: 통제 매핑 → 안정 JSON(기계 소비). */
export function renderControlJson(r: Receipt, hasAnchor: boolean): string {
  const m = buildControlMap(r, hasAnchor);
  return JSON.stringify(
    {
      contractId: r.contractId,
      relation: "evidence-relevant-to",
      disclaimer: "Evidence relevant to controls — not a compliance assessment. Consult your assessor.",
      isoNote: ISO_NOTE,
      limitNote: LIMIT_NOTE,
      source: m.source,
      evidenceTierNote: "audit-evidence hierarchy (AS 1105/ISA 500): A external·independent (Rekor) > B git-measured > C capture self-reported. self-report=advisory, not a PASS/FAIL input.",
      noVerification: m.noVerification,
      entries: m.entries.map((e) => ({ ...e, evidenceTier: tierOf(e.signal) })),
    },
    null,
    2,
  );
}

/**
 * `agent-receipt controls [--receipt <p>] [--format md|json] [--redact]` — 저장 receipt 를 읽어 관련 통제 증거맵 출력(읽기전용).
 * receipt 미변경(투영). 파싱/형식 실패 = exit 2.
 */
export function runControls(receiptPath: string | undefined, format: string | undefined, redact: boolean, cwd: string = process.cwd()): never {
  const { abs, receipt: r } = loadSavedReceipt(receiptPath, "controls", cwd); // 13차 council: 공용 로더(경로해석+검증→exit2)
  const hasAnchor = loadRekorAnchor(abs) !== null;
  const isJson = format === "json";
  let out = isJson ? renderControlJson(r, hasAnchor) : renderControlMd(r, hasAnchor);
  if (redact) out = (isJson ? redactJsonText(out) : redactText(out)).text;
  process.stdout.write(out + "\n");
  process.exit(0);
}
