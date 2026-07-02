# 0.12.0 — the Evidence Graph release

> Status: prepared on branch `v0.1-verify-check-split`; **unpublished until the owner runs `npm publish`** (2FA). Everything below is additive — no breaking changes to existing commands, receipts, or the ledger. Golden suite (143 cases) byte-stable except deliberately updated `help --all` wording.

## What this release is

0.11.x built the verification engine (deterministic checks → sealed Verification Receipts → replay/signature). **0.12.0 makes that engine consumable**: relationships, triage, regression gating, timelines, a status board, a browsable report, and a formal SDK surface.

## New

- **Evidence Graph (name earned)** — `graph view --format json` now includes `graph: { nodes, edges }`: Receipt / Claim / Check nodes; edges `asserts`, `checked_by`, `same_input`, `same_commit`, `reverifies`. Every edge carries a machine-readable `basis` (what recorded fact produced it) and a trust `tier` — `verified` **only** when this tool recomputed the fact itself (e.g. both input files re-hashed); self-reported fields (commit, `verifiedAt`) stay `reported`, never laundered. Unsealed receipts are flagged `tampered`, not hidden. Same-(input·version·verdict) re-runs fold into one node with `occurrences`/`verifiedAtAll` preserved.
- **Failure-first triage** — `graph failures` (filters: check/status/subject/model/commit/input/`--sealed`/`--since`; `--by` grouping; `--limit` always prints "N of M").
- **Regression gate** — `graph diff` (two dirs, or one dir split by commit): new / resolved / status-changed / persisting / per-input verdict changes / per-subject deltas (`bySubject`); **exit 1 when new failures exist** (a set-comparison fact usable in CI). Optional `--match fingerprint`.
- **Claim fingerprint v1** — `cfp1:` + sha256(NFC/whitespace-normalized statement, sourceUrl, sorted check kinds). Embedded in new research receipts; recomputed identically for old ones (one kernel function).
- **Timelines** — `graph history --claim <cfp|prefix> | --input <sha> | --subject <s>`: first appearance, per-step new/resolved/status/evidence changes, tamper flags, related edges. Git-style prefix resolution (ambiguity fails loudly with candidates).
- **Subject status board** — `graph subjects`: pure per-subject counts (no scoring/trends; deltas come from `diff`).
- **Evidence Browser (static HTML)** — failure-first reorder: Dashboard → Failures tabs (byCheck/byModel/bySubject/byCommit/byReason) → Reason (expected↔actual evidence) → affected claim → **1-click claim history** → the receipt as the last drill-down. Subjects board tab. Self-contained, no server, no external resources; quote-safe escaping.
- **Self-dogfood** — every `npm test` verifies fixed fixtures and accumulates this repo's own verification receipts (plus one intentionally tampered exhibit that keeps the `tampered` flag exercised on real data).
- **SDK surface** — Stable / Provisional tiers with a semver promise ([docs/SDK.md](./SDK.md)); runnable, smoke-tested examples (`examples/`).

## What this release does **not** claim

- No semantic claim identity — fingerprint v1 is normalized-text identity; a reworded claim is a different claim, and expanding the check set can split an identity (the `cfp1:` prefix versions the recipe).
- "Resolved" in diff/history means *no failure with that key at that point*, not proof of a fix.
- `verifiedAt` ordering (history, `reverifies`) rests on a caller-injected timestamp — labeled self-reported everywhere.
- No recommendations, no auto-fixes, no scores: reasons/hints/rollups are fixed mappings and neutral counts.
- Engine limits unchanged: local git evidence only; no cloud; no compliance guarantee.

## Compatibility

- Receipts: additive only (`fingerprint` on new research results). Old receipts work everywhere (fingerprints recomputed). Council receipts' `results` are now per-supporting-claim (statement/sourceUrl/fingerprint/checks/evidence/verdict + decision meta) — same shape research uses, so ungrounded failures flow into failures/diff/history; the decision-level chain stays in the DecisionLog (this shape was introduced and corrected within this unpublished release).
- JSON contracts: `graph view --format json` gained keys (`graph`, `subjects`; `indexes`/`failures` events gained fields). Nothing removed or renamed.
- Contract freezes: edge `type`/`basis`/`tier` enums, diff `match` modes, `cfp1:` meaning — additions allowed, meaning changes forbidden (EVIDENCE_SPEC.md).

## Verify before publishing (owner checklist)

```
cd ~/agent-receipt
npm test                # full suite + golden 143 + self-dogfood
npm pack --dry-run      # dist / templates / README / CONTRACT only — no secrets, no docs/examples
npm publish             # 2FA — the only step this branch does not do
npm view @promptia-labs/agent-receipt version   # expect 0.12.0
npm i -g @promptia-labs/agent-receipt@latest    # refresh global hooks
```
