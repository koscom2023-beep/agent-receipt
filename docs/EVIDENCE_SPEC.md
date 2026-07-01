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
| `link` | URL is well-formed http(s) — **advisory, not evidence** | valid / invalid |

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

**A receipt is a record (증적), not a proof (증명).** It attests: *this verifier version produced this result on this exact input, under this recorded provenance.* It does **not** attest that the model truly used that prompt, that the commit connects to that run, or that the reported provenance is true — nor that the AI's judgment is right. `receiptId` (stable) is the reconciliation key; `contentHash` (with timestamp) is the full tamper seal.

## Guarantees (narrow and honest)

- **Reproducible**: same input → same result on any machine. Deterministic, no LLM call, no hidden logic.
- **Model-agnostic**: verifies any vendor's output (Claude, GPT, Gemini, Cursor, …), not just one — an *independent* check, not a vendor auditing itself.
- **What it verifies**: the *evidence a claim rests on* — its citations, numbers, calculations, dates, sources, hashes.
- **What it does NOT verify**: whether the AI's *judgment* is right — the reasonableness of a conclusion, a missing consideration, a better alternative. That needs a human or another process.

> "agent-receipt does not certify that an AI's judgment is correct. It independently and reproducibly checks the verifiable elements the AI presented — its citations, numbers, calculations, sources."
