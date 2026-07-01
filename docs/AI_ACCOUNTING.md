# Why this shape — the design philosophy (internal)

> **Internal design doc, not a user manual.** Users learn "how to trust AI work,"
> not accounting. This page is where the *why* lives — and the only place the
> accounting parallel is drawn in full. External surfaces (README, `--help`,
> command output) use plain terms: **Evidence · Receipt · Ledger Entry · Audit**.

## The one idea

Accounting is not about numbers; it is a **system for producing trust cheaply.**
Banks, investors, and auditors don't trust a company, so: evidence → books →
audit → trust. AI development has the same gap — an agent says "done," a human
says "really?" — and the same answer applies: **evidence → verification → an
append-only record → audit → trust.** We borrow that *structure*, not its jargon.

## Why each object exists (purpose, one line each)

- **Claim** — what the agent *says* it did. Never trusted; only compared.
- **Observation** — what git *actually* shows. The measured ground truth.
- **Difference** — Claim minus Observation. The hidden/over-claimed delta. Keeping
  these three separate is the whole point; merged, lie-detection disappears.
- **Receipt** — Claim+Observation+checks+environment, verified and **sealed** with
  an integrity hash. The reviewed, posted record.
- **Ledger Entry** — an append-only, hash-chained *line* that **points to** a
  sealed receipt and carries a minimal verdict. Not a copy; a reference.
- **Audit** — read-only judgment *over* the ledger (`risk`/`controls`/`insights`).
- **Publication** — how a verified fact leaves the machine (`share-proof`/`anchor`).

## What it is like — and where the analogy stops

| System | Same as us | Different from us |
|---|---|---|
| **Accounting** | separate evidence / posted record / append-only ledger; corrections are new entries, never erasures | double-entry balances *money*; we reconcile *Claim vs Observation*. No debits/credits. |
| **Git** | content-addressed immutable objects; the *object store* is the durable part, not the viewer | git records what humans committed; we record what the AI *actually did* + whether its claim held. |
| **Event sourcing** | append-only log, replayable | an event log is for *rebuilding state*; our ledger is for **accountability** — who did what, provably. |
| **Forensics** | chain of custody; tamper-evidence; each item's provenance | forensics links crime evidence; we link *work* evidence — same custody discipline, different domain. |
| **DDD** | objects (nouns) are primary; commands (verbs) operate on them | we resist turning ~50 CLI verbs into the mental model; the six nouns are. |

The analogies converge on one durable core: **an append-only, hash-chained log of
pointers to immutable, content-addressed records.** That is the structure most
likely to survive a decade.

## The invariants (the 10-year core — do not drift)

1. **Byte-invariant** — new fields are metadata, present-only, **excluded from the
   integrity hash**; existing output stays byte-identical.
2. **Claim ≠ Observation** — never merged. Lie-detection is the heart.
3. **Git-only, no cloud** — local files + stdout JSON. No SaaS, graph store,
   network transport, SDK, or webhook implementation.
4. **Honest verbs** — `evidence-relevant-to` / `supports` only. No `satisfies`,
   no stored `contradicts`, no scores / grades / predictions.
5. **Pointer, not copy** — the ledger references sealed receipts; it never inlines
   evidence or values.
6. **Standards are adopted, not announced** — define our own semantics rigorously;
   never declare an industry standard.

## The one rule that keeps this healthy

**Borrow accounting's ideas; do not make accounting's words the product's
language.** Internally, think transaction → voucher → ledger → audit. Externally,
say Evidence → Receipt → Ledger Entry → Audit. See open design questions in
[`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md); the ledger deep-dive in
[`AI_LEDGER_MODEL.md`](AI_LEDGER_MODEL.md); the object map in
[`EVIDENCE_MODEL.md`](EVIDENCE_MODEL.md).
