# Agent Receipt Format Specification (Draft v1.1)

_Promptia Labs · open format for AI-work audit receipts · 2026-07_

> **Purpose.** This document defines the format of an "AI coding agent change-audit receipt" **independently of any tool**. The goal is that a third party (an auditor, a client, a regulator, or a different vendor) can **verify and emit receipts without trusting the `agent-receipt` implementation**. That is what makes this a candidate *standard* rather than one tool's output.
>
> **Status.** Draft. The normative source of truth is the reference implementation (`@promptia-labs/agent-receipt` v0.24, `schemaVersion` `"1.1"`). Byte-level conformance is pinned by the test vectors in `test/vectors/vectors.json` (see section 8).

---

## 1. Terms

- **Receipt**: a JSON object holding a point-in-time snapshot of git work plus a verdict.
- **Seal (`contentHash`)**: a SHA-256 integrity hash over the receipt body.
- **Proof Bundle**: a folder bundling a receipt plus optional signature, anchor, and evidence files.
- **Issuer**: the party that produces a receipt (a team's CI).
- **Verifier**: the party that checks a receipt (an auditor, a client, a regulator, CI).

## 2. Receipt object

A JSON object. Principal fields (reference implementation):

| Field | Type | Sealed | Notes |
|---|---|:--:|---|
| `schemaVersion` | string | no | Format version. Currently `"1.1"`. Excluded from the seal (it is a version marker, so the hash is stable across it). |
| `kind` | string | n/a | Receipt kind (work / verification). |
| `headHash` | string | yes | git HEAD commit hash. |
| `branch` | object | yes | `{ current, expected, ok }`. |
| `contractId` | string | yes | Work-contract identifier. |
| `touched` / `staged` / `untracked` / `outOfScope` | string[] | yes | Changed / staged / untracked / out-of-scope paths (sorted before sealing). |
| `deniedHits` | string[] | yes | Paths that hit a deny rule (sorted). |
| `magnitude` | object | yes | Change magnitude (file count, added, deleted, newFiles). |
| `criticalPaths[]` | object[] | yes (touched only) | Critical-path glob plus hits. The seal uses `criticalTouched` (flattened, sorted). |
| `checks[]` | object[] | yes | Check results. The seal uses `name:exitCode:requiredExit:ok` strings (sorted). |
| `ok` | boolean | yes | **Final pass/fail.** (sealed since v1.1) |
| `violations` | string[] | yes | Violation list (sorted, `[]` when none). |
| `verdict` | object? | yes (when present) | Session verdict. Attached by `done`, then re-sealed. |
| `contractSnapshot` | object? | yes (when present) | Contract minimal fields plus `contractHash`. |
| `actions[]` | object? | yes (digest) | capture (beyond-git behavior). The seal uses `actionsDigest = "sha256:" + sha256(stableStringify(actions))`. |
| `reconciliation` | object? | yes (digest) | git-vs-capture reconciliation. The seal uses `reconciliationDigest`. |
| `contentHashes[]` | object? | yes (when present) | sha256 of touched files (content not stored). The seal uses `path:sha256` (sorted). |
| `actionsSummary` / `tapSummary` | object? | no | Summary / observation metadata (excluded from the seal). |
| `environment` / `timestamp` / `measuredFrom` / `disclosure` | n/a | no | Provenance, time, limits (machine- and time-variant, so excluded). |
| `contentHash` | string | n/a | The seal value itself (`"sha256:" + hex`). |

## 3. Seal (`contentHash`) computation (normative)

A third party must do exactly this to reproduce the seal.

**3.1 Canonicalization (`stableStringify`).** Use `JSON.stringify`, but **recursively sort every object's keys** in lexicographic order. Arrays keep their order (the caller sorts them beforehand). Number and string encoding follow standard ES `JSON.stringify`. _(Note: this is similar to but **not identical** to RFC 8785 JCS. For this format the seal is defined by `stableStringify`. The separate log / ledger layer uses RFC 8785 JCS.)_

**3.2 Seal preimage (payload).** Build an object with the following keys (include optional keys **only when present**):

```
{
  headHash,
  touched: sort(touched), staged: sort(staged),
  untracked: sort(untracked), outOfScope: sort(outOfScope),
  deniedHits: sort(deniedHits),
  magnitude,
  criticalTouched: sort(flatten(criticalPaths[].touched)),
  checks: sort(checks.map(c => `${c.name}:${c.exitCode}:${c.requiredExit}:${c.ok}`)),
  ok,
  violations: sort(violations ?? []),
  branch, contractId,
  verdict?            // present only when present
  contractSnapshot?   // present only when present
  actionsDigest?         = "sha256:" + sha256(stableStringify(actions))        // only when actions present and non-empty
  reconciliationDigest?  = "sha256:" + sha256(stableStringify(reconciliation)) // only when present
  contentHashes?      = sort(contentHashes.map(c => `${c.path}:${c.sha256 ?? "null"}`)) // only when present
}
```

**3.3 Final.** `contentHash = "sha256:" + hex(sha256(utf8(stableStringify(payload))))`.

**Invariants.** `schemaVersion`, `environment`, `timestamp`, `tapSummary`, and `actionsSummary` are excluded from the seal. A missing optional field must have **no key at all** (backward compatibility and byte stability).

## 4. Proof Bundle (folder layout)

| File | Required | Content |
|---|:--:|---|
| `receipt.json` | yes | The Receipt object above. |
| `anchor.dsse.json` | opt | DSSE envelope: `{ payloadType, payload(base64), signatures:[{ sig(base64), keyid? }] }`. The payload is an in-toto Statement (section 5). |
| `public.pem` | opt | ed25519 public key for signature verification (SPKI PEM). |
| `anchor.rekor.json` | opt | Transparency-log sidecar: `{ uuid, verifyUrl, logIndex }`. |
| `evidence/*.json` | opt | Verification receipts (offline replay targets). |

## 5. Signature (DSSE), normative

**5.1 Statement.** The DSSE payload is an in-toto Statement.

For a **proof bundle over a work receipt** (what `share-proof --bundle` and `attest` produce), the reference implementation uses `predicateType` `https://promptia-labs.dev/agent-receipt/ai-work/v0.1`. Its subjects are:
- `{ name: "ai-work-receipt", digest: { sha256: <contentHash without the "sha256:" prefix> } }`
- `{ name: "git-commit", digest: { gitCommit: <headHash> } }`

The predicate carries verdict-relevant fields (`ok`, `branch`, a compacted `checks` list of `{name, ok}`). Because `subject[0].digest.sha256` binds to the receipt `contentHash` (section 3) and the seal now covers the verdict fields, tampering with either the receipt body or the verdict breaks this binding.

A **separate** path (`predicate --sign`) signs *verification* receipts (research / council / bench) with `predicateType` `https://promptia-labs.dev/agent-receipt/claim-verification/v1`, whose `subject[0].digest.sha256` is the verification receipt's `contentHash`. See `docs/PREDICATE.md`.

**5.2 PAE (Pre-Authentication Encoding).** The signed bytes are the DSSE-standard PAE:
```
"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload
```
**5.3 Algorithm.** ed25519. The signature is verified over the PAE bytes. The key is `public.pem` (SPKI).

## 6. Verification procedure (normative)

A Verifier, in order:

1. **receipt-parse**: `receipt.json` parses.
2. **receipt-hash**: recompute `contentHash` (section 3) and compare. **A mismatch must fail.** If `schemaVersion < 1.1`, soften the *wording only* to "tampered, or a pre-0.24 format that must be re-issued" (the status stays fail: pre-0.24 receipts used a weaker seal and must not be honored). If `schemaVersion >= 1.1`, it is a tamper signal.
3. **dsse-signature / dsse-subject**: if `anchor.dsse.json` and `public.pem` are present: verify the ed25519 signature over the PAE, and check that the Statement subject digest equals the receipt `contentHash`.
4. **rekor-sidecar**: if `anchor.rekor.json` is present, check its shape (`uuid` length >= 40, `verifyUrl` present). _Offline, zero network._
5. **evidence-replay**: if `evidence/*.json` are present, recompute each seal.

**Overall verdict.** The bundle passes if no check is `fail`. **However, a passing offline check does not by itself mean "unchanged since creation."** The seal is an unkeyed SHA-256 that anyone can recompute, and a self-managed DSSE key is held by the issuer, so both can be present on a forged bundle. A Verifier should therefore only claim the stronger "unchanged since creation" language when there is an **independent third-party anchor (a Rekor entry)**, and even then the real confirmation is a human opening the transparency-log link (this command is offline). Otherwise state the result as **self-attested integrity**.

**Exit codes.** `0` = pass, `1` = verification failure, `2` = input error.

## 7. Trust model (honest disclosure)

- A self-managed key signature shows **integrity and key-possession**, but **not identity**. Identity comes from outside (an online-confirmed transparency-log entry, or a pinned key).
- The mere presence of a Rekor sidecar does not prove the entry exists or is bound (online confirmation is separate).
- This format is **evidence for compliance review**, not a compliance guarantee.

## 8. Standardization to-do (before a formal release)

1. **Conformance test vectors**: `test/vectors/vectors.json` holds `(receipt, expectedContentHash)` pairs generated by the reference implementation (`node test/vectors/generate.mjs`). Another implementation can recompute the seal (section 3) over each `receipt` and check it equals `expectedContentHash`. These are re-verified in CI by `test/receipt-vectors.test.mjs`, which also guards the seal against accidental change.
2. **Spec URL namespace**: pin something like `spec.promptia.kr/agent-receipt/1.1`, and fix the `predicateType` URIs.
3. **Formal JSON Schema**: publish an authoritative schema (extending the implementation's `claimSchema`).
4. **Version policy**: `1.1` to `1.x` is additive; any change to the seal preimage (section 3.2) is a major version.
5. **Open governance**: a standard is adopted only when control is shared, so state the governance model.

> This draft reflects the actual implementation as read from the code. The test vectors in section 8.1 pin it byte-for-byte; run them before treating this as final.
