# The AI Ledger — data model & semantics

> Deep-dive on the one object that outlives every feature: the **ledger**.
> For the whole pipeline see [`EVIDENCE_MODEL.md`](EVIDENCE_MODEL.md); this page
> is only about what the ledger *is*, what a line *means*, and what it deliberately
> does **not** hold. Grounded in the current code (`src/ledger.ts`), not aspiration.

## 1. What the ledger is (and is not)

Accounting keeps three distinct things, and so does agent-receipt:

| Accounting | agent-receipt | Where it lives |
|---|---|---|
| Evidence (증빙) — invoice, contract | git diff, `capture` actions, the AI's claim | measured live; the raw signals |
| Voucher (전표) — the reviewed, posted record | the **Receipt** (`.agent-guard/receipts/<ts>.json`) + its `contentHash` | one file per receipt |
| Ledger posting (전기) — the append-only book line | a **LedgerEntry** (`ledger.jsonl`) | one line per receipt |

**The ledger does not store the receipt, and it does not store the evidence.**
A ledger line is a **posting**: a *pointer to a sealed receipt* plus a *minimal
verdict summary* plus *chain linkage*. The detail stays in the voucher (receipt);
the evidence stays in git and the capture log. This is the accounting answer to
the owner's question — *what goes in the ledger?* → **not the receipt, not the
evidence, but a verdict-posting that references them.**

## 2. What a line stores today (grounded — `ledgerEntryFromReceipt`, ledger.ts:38)

```
timestamp · contractId · branch · headHash · ok
receiptPath              ← where the voucher is
contentHash              ← the sealed hash of the voucher (the real pointer)
criticalTouchedCount · magnitude(filesChanged) · approvalsCount · claimMatched(bool|null)
prevHash? · entryHash?   ← hash-chain: tamper / deletion / reorder evident
```

What it **omits on purpose**: file lists, diffs, values, the claim-mismatch
specifics, the reconciliation residuals, per-check detail. All of that is in the
receipt, reachable by `contentHash`. The line is a *summary + address*, never the
document itself.

## 3. Invariants (the semantics that must never drift)

1. **Append-only.** A posting is never edited or deleted. A correction is a *new
   posting*, exactly as accounting never erases — it books a reversing entry.
2. **Hash-chained.** `entryHash` covers the line **and `prevHash`** → any tamper,
   deletion, or reorder is detectable (`ledger verify`).
3. **Metadata only — no values.** Paths/hashes/counts, never contents or diffs.
   Secrets can't leak through the ledger.
4. **Pointer, not copy.** The line references the voucher by `contentHash`; the
   voucher is the source of truth. `replay` re-checks the pointer.
5. **Flat file, no cloud.** `ledger.jsonl` only. No SaaS, no DB, no dashboard, no
   network. (`ledger.ts:16-18`.)
6. **Opt-in append.** Auto-append is OFF by default (`--ledger` / `rebuild`) —
   the ledger is deliberate, not ambient.

These six are the whole IP. Every application layer (`share-proof`, `audit-pack`,
`controls`, `risk`, any future export) is a *read* over postings that obey them.

## 4. The hard cases (owner's questions — today's behavior + the honest gap)

**A. Claude claims "only auth.ts"; git says auth.ts + package.json.**
- Today: the *receipt* records `touched = [auth.ts, package.json]` (observation)
  and, if a claim was supplied, `claims`/`claimVerify` mark it a mismatch. The
  *ledger line* carries `claimMatched=false`, `magnitude=2`, and the `contentHash`
  pointer. **Honest gap:** the line does **not** carry *which* file was hidden —
  you must open the receipt. (See §6.)

**B. Cursor claims tests pass; CI failed.**
- Today: if the failing check is in the contract's `required_checks`, `check`
  fails → `receipt.ok=false` → `ledger ok=false`. If "CI" is a truly *external*
  system, it is **outside the git-working-tree boundary** — agent-receipt records
  the *claim* as advisory self-report but **cannot verify external CI**. The
  ledger records what git + local checks measured; external CI is out of scope by
  design (the disclosure line). Honesty over coverage.

**C. Human approves, then rolls back.**
- Today: approval is a sidecar (`<receipt>.approval.json`, referencing the
  receipt's `contentHash`); `approvalsCount` rides the ledger line. A rollback is
  a *new commit* → a *new* receipt/ledger posting. The ledger is append-only, so
  the old approval line is never mutated; the revert is a new line. The *link*
  ("this revert undoes that commit") lives in **git history + `headHash`**, not
  yet as an explicit ledger relation. **Honest gap:** there is no stored
  `supersedes` edge — the connection is implicit via git. (Making it explicit is a
  frozen item, §7.)

## 5. Why the current structure is already right

The line is a *posting that references a sealed voucher*, not a copy of it. That
is precisely why accounting ledgers survived centuries and why git's object store
(not its commit viewer) is the durable part: **the durable core is an append-only
log of pointers to immutable, content-addressed records.** agent-receipt already
has that shape. The work is not to replace it — it is to keep it honest and, where
thin, enrich it *without breaking the chain*.

## 6. Enriching the thin line — one byte-safe field added, one still a candidate

Grep-ing the ledger used to answer "which commits, how big, approved?" but not
"which commits had an unexplained capture residual" — you had to open each receipt.

- **Implemented (byte-safe):** `reconUnexplained?` — the count of unexplained
  reconciliation residuals (§4) surfaced on the ledger line. Present-only (absent
  when there was no capture, or zero) and **excluded from `ledgerEntryHash`**
  (ledger.ts:61) so the chain and every existing line stay byte-identical. Now
  `grep reconUnexplained ledger.jsonl` finds the gap-bearing commits without
  opening a single receipt.
- **Still a candidate:** `claimHiddenCount` (how many files a claim hid). Deferred —
  `claimMatched` already flags *that* a claim mismatched, and the count would need
  threading from the caller. Add only if real usage asks.

The rule for any future line field is fixed: **present-only, and out of the hash.**

## 7. Frozen — recorded as vision, not plan (guardrails hold)

The following are honest long-term possibilities, **deliberately not built** and
not to be enshrined as a roadmap until there is real-user signal *and* a design
that does not cross an invariant:

- **Explicit relations** (`supersedes`, `reviewed_by`, `contradicts`) as stored
  ledger edges — would risk over-claim and a graph store (crosses §3.5).
- **Cross-machine / team aggregation, Evidence Bus, SIEM export** — network
  transport, outside git-only.
- **The Promptia closed loop** (ledger → prompt evolution as a *learning asset*).
  Compelling, but it requires a separate product identity and network/data
  aggregation that this git-only tool intentionally is not. Recorded here so the
  idea is not lost — **not** a thing to start.

This tool does not declare an industry "AI Ledger standard." Standards are adopted,
not announced. It defines *its own* ledger semantics rigorously; that consistency
is the competitive edge.

## 8. Open questions (research seeds — for the human, not the tool to guess)

- When two agents touch the same file in one session, is that one posting or two?
- Should a purely-read session (no git change) produce a posting at all? (Today:
  `close-recon` can, with zero changes.)
- What is the minimal verdict a posting must carry to be *self-explanatory* on
  `grep` without opening the voucher — and where is the line between "summary" and
  "leaking the diff"?

*These are for deliberate human design, grounded in real ledgers once they exist —
not for the tool to invent answers to.*
