# agent-receipt Compliance Crosswalk

_Which control requirements an agent-receipt receipt can serve as **evidence** for._
_Promptia Labs · 2026-07 · draft_

> **What this is for.** A quick reference for a first conversation with an auditor or a compliance owner: which control items an agent-receipt receipt supports as evidence.
>
> **Honest disclosure.** agent-receipt provides **evidence for review, not a compliance guarantee.** Each mapping below is a claim that "this evidence supports this control." The final judgment belongs to each organization's auditor. Framework clause numbers and effective dates are as of the time of writing and must be re-confirmed before use (regulations change; see the EU note below).

---

## Summary mapping

| Framework | Relevant requirement | Evidence agent-receipt provides |
|---|---|---|
| **SOC 2** | CC8.1 change management (approved, documented changes) | A tamper-evident receipt per PR of "what changed plus checks and verdict passed." |
| **ISO/IEC 42001** (AI management system) | AI lifecycle controls and records, AI-BOM and traceability | A portable record of the authorship and review of agent-made changes. |
| **EU AI Act** | Art. 12 automatic logging and traceability / Annex IV technical documentation | Development-stage change logs and provenance (evidence for the stage that *builds* a system). |
| **NIST SSDF** (SP 800-218) | Code integrity and provenance practices | Change integrity hash plus signature plus optional transparency-log anchor. |
| **Korea AI Basic Act** | High-impact AI documentation and human-oversight records | Review and verdict records for AI-involved code. |
| **Korea Financial AI Guideline** | AI as an assistive tool, human accountability, records | The `verdict` (human review) plus a change-evidence audit trail. |

---

## 1. SOC 2 CC8.1 (change management): most direct

**Requirement.** An organization must show that infrastructure, data, and software changes are approved, designed, and documented. When the change author is non-human (an AI agent), the auditor wants evidence of what, why, and whether it was reviewed.

**Evidence.** A tamper-evident receipt per PR or commit carrying `touched`, `magnitude`, `checks`, `ok`, and `verdict`. git history can be rewritten by rebase or force-push, but the receipt is sealed by `contentHash` plus an optional signature, so post-hoc tampering shows. Human review (`verdict`) is inside the seal (v1.1), so "reviewed" cannot be forged.

**Limit.** A receipt does not prove that an organizational approval *policy* exists (that is a separate policy document). The receipt is the evidence that "this change was what it was and passed its checks and review."

## 2. ISO/IEC 42001 (AI management system): growth driver

**Requirement.** Documented controls and records across the AI lifecycle. Audit practice increasingly asks for an "AI bill of materials (AI-BOM)" and file-level traceability.

**Evidence.** A portable record of which changes came from an AI agent (authorship attribution) and whether they were reviewed, vendor-neutral across Cursor, Copilot, and Claude Code. A set of receipts is an auditable trail of how AI was used in the SDLC.

## 3. EU AI Act Art. 12 / Annex IV: large but indirect and deferred

**Status.** High-risk obligations were deferred by the Digital Omnibus agreement (2026-05-07): Annex III to about 2027-12, Annex I to 2028. The original 2026-08-02 date moved. Coding agents themselves are usually not "high-risk," so demand here is secondary (documenting the high-risk *system* an agent helped build).

**Sales note.** Do not sell with an "August 2 deadline." Frame it as "the direction is set; preparing now lowers later cost."

## 4. NIST SSDF (SP 800-218): US, weaker in 2026

**Requirement.** Secure development practices, code integrity and provenance. A gen-AI profile extends this to AI-generated code.

**Note.** OMB M-26-05 (2026-02) made federal self-attestation discretionary, so this driver weakened. Position it as a supply-chain security best practice rather than a mandate.

## 5. Korea: home market, soft regulation

- **AI Basic Act** (effective 2026-01, enforcement about 2027, penalty cap about 30M KRW): documentation, explanation, and human-oversight records for high-impact AI. Receipts contribute as "review and verdict records for AI-involved code."
- **Financial AI Guideline** (effective 2026-06, soft law): "AI is assistive, humans are accountable." The receipt `verdict` (human review) plus change evidence is exactly this principle's audit trail.

---

## Using this in an auditor conversation

1. Lead with **"evidence, not a guarantee."** It earns the auditor's trust.
2. Pick the counterpart's **one** framework (SOC 2 or ISO 42001) and show only that row.
3. Ask, as a question, whether this receipt could be accepted as evidence for their control X. Making the auditor the judge is how recognition (and the channel moat) grows.
4. Re-confirm clause numbers and effective dates before the conversation. Regulations move (the EU actually deferred).
