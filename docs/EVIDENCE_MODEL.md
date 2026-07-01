# Evidence Model (domain model, 1-page)

agent-receipt is **not a bag of ~50 CLI commands** — it is one pipeline over six
objects. The commands are just verbs that *produce* or *transform* these objects.
This page maps each object to the code that already implements it.

> **These objects already exist.** This is a naming/representation map, **not a
> build roadmap.** Nothing here is a new type to construct.

```
 AI Session ──▶ Evidence ──▶ Verification ──▶ Verified Receipt ──▶ Ledger ──▶ Audit ──▶ Publication
   begin        capture         verify           receipt           ledger     risk       share-proof
   start        claims          check            done                         controls   anchor
   contract     git observ.     reconcile                                     insights   export
```

## The six objects → today's code

| Object | What it is | Already implemented as | File |
|---|---|---|---|
| **Session** | one unit of AI work (a baseline) | `SessionData` / `resolveSession` (branch + baselineHead ancestor check) | `start.ts` · `session.ts` |
| **Evidence** | the raw signals of what happened | AI `Claim` (self-report), git observation (`runVerify` touched/denied/scope), `CaptureRecord` (beyond-git actions), required checks | `claims.ts` · `checks.ts` · `capture.ts` |
| **Fact** *(verification)* | Claim + Observation + Policy + Check reconciled into a verified fact | **`buildReceipt`** — this composition *is* the "Fact Engine". `claimVerify`/`diffClaimField` compute Claim≠Observation; `reconcileCapture` reconciles git↔capture | `receipt.ts` · `claimdiff.ts` · `capture.ts` |
| **Verified Receipt** | the sealed fact summary + integrity hash | `Receipt` + `receiptHash` (deterministic; timestamp/env/actions/reconciliation **excluded**) | `receipt.ts` |
| **LedgerEntry** | append-only, hash-chained record of each receipt | `LedgerEntry` + `appendLedger` + `verifyLedgerChain` (tamper/deletion/reorder-evident) | `ledger.ts` |
| **Audit** | read-only judgment over the ledger/receipts | `risk` · `controls` (evidence-relevant-to controls, A/B/C tiers) · `insights` · `incident` · `audit-pack` · `replay` | `risk.ts` · `controls.ts` · `insights.ts` · `auditpack.ts` |
| **Publication** | how a fact leaves the machine | `share-proof` (self-contained HTML) · `anchor` (Rekor seal) · `attest` (in-toto) · `export` (stdout preview) | `shareproof.ts` · `anchor.ts` · `attest.ts` |

**The ledger is the durable core** — the one object that outlives every feature.
Deep-dive on its data model & semantics: [`AI_LEDGER_MODEL.md`](AI_LEDGER_MODEL.md).

**Key point:** *Claim ≠ Observation ≠ Difference* is already separated in code —
Claim (`claims.ts`), Observation (`runVerify` → `Receipt`), Difference
(`diffClaimField` in `claimdiff.ts`). The receipt is a *verified, sealed* record
(accounting would call it a voucher — an analogy, not our vocabulary).

**See also:** the design philosophy and cross-discipline comparisons in
[`AI_ACCOUNTING.md`](AI_ACCOUNTING.md); the ledger deep-dive in
[`AI_LEDGER_MODEL.md`](AI_LEDGER_MODEL.md); unresolved design questions in
[`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md).

## Invariants (do not cross)

1. **Byte-invariant.** New receipt fields must be **excluded from `receiptHash`**
   (metadata only, present-only) — see `actions` / `reconciliation`. The golden
   suite locks receipts byte-identical.
2. **Honest verbs.** Relations/controls stay `evidence-relevant-to` / `supports`.
   No `satisfies`, no `contradicts` as a stored claim, no scores/grades/predictions.
3. **Git-only, no cloud.** Local files + stdout JSON only. No SaaS, no graph store,
   no network transport, no SDK/webhook implementation.

## Roadmap (frozen until real-user signal — WAU repos ≥ 5)

Evidence Query, per-agent Analytics, an Evidence event Bus, a materialized graph
store, anomaly/fraud scoring, and a Prompt-evolution loop are **out of scope**
until there is real usage to justify them. They would each cross an invariant
above or answer a question no current user is asking. Ship the representation
first; earn the platform.
