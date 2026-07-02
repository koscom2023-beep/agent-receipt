# Evidence Specification (`evidence/1`)

The versioned, machine-readable format for a **verifiable AI-work claim**. This is the artifact others adopt — the moat is not any single checker but this format becoming a shared standard (as Git's object model, not `git hash`, became the standard).

Emit it: `agent-receipt spec` (human) · `agent-receipt spec --format json` (JSON Schema draft-07, generated from the check registry — the code is the spec).

## The model

A **claim** carries one or more **typed checks**. Each check is graded by a deterministic, non-LLM function. `research verify` and `council verify` both grade claims through the same kernel (`evaluateClaim`), so the semantics are one thing, not two.

```
schemaVersion: "evidence/1"
claim:
  statement      # 표시용·미검증
  # citation
  quotedText  +  (sourceText | sourceFile | live sourceUrl via --fetch)
  # number
  statedValue  +  (source | op + operands)
  # date
  statedDate   +  source
  # link
  link         # URL well-formedness
  # hash (integrity)
  statedHash   +  (content | contentFile)  +  algo?
```

## Check kinds & statuses

| kind | verifies | statuses |
|---|---|---|
| `citation` | quotedText is a literal substring of the source | verified / not-found / no-source |
| `number` | statedValue == a number in the source, or == recompute(op, operands) | verified / mismatch / no-basis |
| `date` | statedDate == a date in the source (format-agnostic) | verified / mismatch / no-basis |
| `hash` | sha256/… of content == statedHash (integrity) | verified / mismatch / no-basis |
| `signature` | content is ed25519-signed by the given public key (non-repudiation) | verified / invalid / no-basis |
| `link` | URL is well-formed http(s) — **advisory, not evidence** | valid / invalid |

`signature` is the one check that promotes self-report toward proof: it confirms *this content was signed by this key* — it does not vouch for the key's trust (that is out of scope).

A claim **fails** if any check is `not-found` / `mismatch` / `invalid`. A claim is **verified** if a positive check (citation/number/date/hash) is `verified` and nothing failed. `link: valid` is advisory (well-formedness ≠ evidence).

## Extensibility (the engine, not just checkers)

New verifiers register in the **check registry** (`CHECK_REGISTRY`) — one descriptor, no engine change. `spec` reflects them automatically. Planned next: `file`, `formula`, `version`, `dependency`, `signature`, `artifact`, `replay`. This is what raises the copy cost: not the checkers, but the extensible engine + shared format.

This is a **plugin / registry** dispatch, **not** an "Evidence VM" — there is no DSL, opcode set, or execution state yet. That would be a later stage; today it is a clean plugin point.

## Provenance & Verification Receipt

A report may carry a `provenance` block: `{ model, prompt, inputFiles, commit, tests, author }`. It is **tiered by trust**, never stored flat — self-report must not be laundered as fact:

- **`verified`** — what we actually computed or checked: `commitExistsInRepo` (the stated commit **exists** in git, or `null` outside a repo) and `inputFiles[].sha256` (we hash each file). Computationally / git-verifiable. Note the name: `commitExistsInRepo` means *the commit is present in the repository* — it does **not** mean this receipt was generated from that commit (that linkage is still self-report).
- **`reported`** — self-report echoed verbatim: `model`, `prompt`, `author`, `tests`. We cannot verify that a given model actually used a given prompt today, so it stays labeled as report.

`research verify --out <path>` (and `council verify --out <path>`) seal the run into a **Verification Receipt** — a durable, linkable artifact instead of ephemeral stdout:

```
schemaVersion, kind: "verification-receipt",
receiptId,                     # sha256(schemaVersion + inputSha256 + verifierVersion + verdict)
                               #   deterministic, timestamp-free → same input+verifier+verdict = same id
                               #   (a cross-system reconciliation key)
surface, verifiedAt, tool { name, version },
input { file, sha256 },        # the exact input, hashed (chain of custody)
subject,
provenance { verified {…}, reported {…} },
results [ per-claim/decision ], summary, verdict,
means,                         # "a record that this verifier version produced this result on this input"
contentHash                    # sha256 of all the above incl. verifiedAt (full tamper-evidence)
```

`replay --receipt <path>` re-verifies a saved receipt over time: recompute `contentHash` and `receiptId` (tamper detection), re-hash the input file if still present (`input.sha256` drift), and re-check `commitExistsInRepo` (link-rot). This is L5 reproducibility — the receipt is checkable long after it was written.

**A receipt is a record (증적), not a proof (증명).** It attests: *this verifier version produced this result on this exact input, under this recorded provenance.* It does **not** attest that the model truly used that prompt, that the commit connects to that run, or that the reported provenance is true — nor that the AI's judgment is right. `receiptId` (stable) is the reconciliation key; `contentHash` (with timestamp) is the full tamper seal.

## Guarantees (narrow and honest)

- **Reproducible**: same input → same result on any machine. Deterministic, no LLM call, no hidden logic.
- **Model-agnostic**: verifies any vendor's output (Claude, GPT, Gemini, Cursor, …), not just one — an *independent* check, not a vendor auditing itself.
- **What it verifies**: the *evidence a claim rests on* — its citations, numbers, calculations, dates, sources, hashes.
- **What it does NOT verify**: whether the AI's *judgment* is right — the reasonableness of a conclusion, a missing consideration, a better alternative. That needs a human or another process.

> "agent-receipt does not certify that an AI's judgment is correct. It independently and reproducibly checks the verifiable elements the AI presented — its citations, numbers, calculations, sources."

## Evidence Graph contract (`graph view --format json` → `graph { nodes, edges }`)

A consumer can reconstruct all relationships from this JSON alone (no HTML needed). Every edge is a deterministic restatement of recorded facts — never an inference.

**Folding (0.12.2 fix).** `summary`, `failures`, `indexes`, `subjects`, and the Evidence Browser's receipt list are all computed over receipts **folded by `receiptId`** (the same fold `graph{nodes,edges}` already did) — a repeated re-verification of the same input (same input · tool version · verdict) is one logical result, not one row per file. `summary.total` is the folded (unique) count; `summary.fileCount` is the raw file count before folding — both are always shown, never just one (honesty: a prior version silently used the raw file count as `total`, which is why re-running the same fixture repeatedly made the Dashboard and failure lists look like N distinct problems instead of one repeated result). `FailureEntry`/`FailureEvent` carry `occurrences` (how many files folded into this one) and, on `FailureEvent`, `allFiles`. `graph query`/`graph subjects` text and JSON output fold the same way.

**Nodes** — `type`: `receipt` | `claim` | `check`. Receipt node ids are `receipt:<receiptId>` (or `receipt:file:<name>` when the receipt has no id — such rows are never folded). A same-(input·tool-version·verdict) re-run folds into one node: latest `verifiedAt` kept, all timestamps preserved in `verifiedAtAll`, count in `occurrences`. Seal-replay failures are flagged `tampered`, not hidden.

**Edges** — `{ id, from, to, type, basis, note, tier }`:
- `id`: deterministic — `` `${type}:${from}=>${to}` ``.
- `type` (frozen enum): `asserts` (receipt→claim) · `checked_by` (claim→check) · `same_input` · `same_commit` · `reverifies` (all receipt↔receipt).
- `basis` (frozen enum, machine-readable — *what recorded fact produced this edge*): `receipt-structure` · `input.sha256-rehashed` · `input.sha256-stated` · `reported.commit` · `verifiedAt-order`.
- `note`: human explanation (display only, not contract).
- `tier`: `verified` (this tool recomputed/read the fact directly) | `reported` (rests on a self-reported field). Rules: `same_input` is `verified` **only** when both input files were re-hashed and match (`inputMatch`); `same_commit` is always `reported`; `reverifies` is always `reported` (`verifiedAt` is caller-injected, no recomputation path).

**Enum policy**: adding values is additive (a version bump of this section); changing the meaning of an existing value is forbidden.

## Failure triage & diff (`graph failures`, `graph diff`)

- `graph failures`: read-only query over flattened failure events (each = claim × failed check, with `file`, `verifiedAt` (self-reported), `tampered`). Filters: check/status/subject/model/commit/input/`--sealed`/`--since` (on self-reported `verifiedAt`). `--limit` always prints "N of M" — no silent truncation. Always exit 0 (a query, not a gate).
- `graph diff` (base → head): `newFailures` / `resolvedFailures` / `statusChanged` / `persistingCount` / `inputVerdictChanges` (per shared `input.sha256`, latest-verifiedAt verdict on each side). Matching key = (`input.sha256` ∥ subject) + whitespace-normalized statement + check — **recorded-text identity, not semantic identity**: a reworded claim shows up as resolved + new. "Resolved" means *no failure with the same key in head*, not proof of a fix. Exit 1 when `newFailures` > 0 (a set-comparison fact, usable as a CI gate). The result also carries `bySubject` (per-subject new/resolved/statusChanged/persisting counts — the per-project delta board) and self-describes its `match` mode.

## Claim fingerprint v1 (`cfp1:`) & history

**Fingerprint** — the identity key that ties "the same claim" across time: `cfp1:` + sha256 of (NFC + whitespace-normalized `statement`, `sourceUrl` or empty, sorted check kinds — NUL-separated). Produced by the kernel (`claimFingerprintV1`, single source of truth), embedded in new research receipts (additive field on each result), and recomputed identically by the graph layer for older receipts. Exposed in `graph view --format json` claims, claim nodes, and failure events.

**Honesty (v1)**: text-based — a reworded statement becomes a *different* claim (no semantic identity); because the check-kind set is part of the key, a tool version that adds a new check kind for the same fields can split an identity. The `cfp1:` prefix is the version: a future `cfp2:` may revise the recipe; the meaning of `cfp1:` never changes. A fingerprint is an identity key, not a proof — no trust tier applies.

**`graph history --claim <cfp|prefix> | --input <sha256>`** — timeline of receipts for the same claim/input, ordered by self-reported `verifiedAt` (labeled as such; `file` tie-break). Each item: receiptId/subject/model/commit/verdict/tampered/failed checks, plus changes vs the *previous* item (new failures / resolved / status changed / evidence changed; first item is the baseline). "Resolved" = no failure with that key at that point, not proof of a fix. Claim prefixes resolve like git: unique → used; ambiguous → up to 10 candidates listed (truncation stated), explicit failure. Related receipt-level edges (`same_input` / `same_commit` / `reverifies`) are included in the JSON.

**`graph diff --match fingerprint`** — opt-in matching by (fingerprint + check) instead of the default (input∥subject + statement + check). The result self-describes its `match` mode. Either mode is recorded-text identity — a reworded claim still shows as resolved + new.
