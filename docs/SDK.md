# SDK surface & stability contract

`import { evaluateClaim } from "@promptia-labs/agent-receipt"` — the barrel (`src/index.ts`) is the whole SDK surface. The CLI stays primary; the SDK exposes **the same functions the CLI uses**, so the `graph view --format json` contract and the SDK are produced by one implementation — one semantics, two consumers.

## Tiers

| Tier | Meaning | Where |
|---|---|---|
| **Stable** | Semver promise. We aim not to break these even on 0.x; if a break is unavoidable: CHANGELOG entry + at least one minor of deprecation notice first. | "Stable" block in the barrel |
| **Provisional** | Usable today, may change without notice — not a contract. Promoted to Stable (non-breaking) when external demand appears. | "Provisional" block in the barrel |
| **Internal** | Everything not in the barrel. Deep imports (`dist/*.js`) carry **no** guarantee. | not exported |

## Stable surface (summary)

- **Evaluate**: `evaluateClaim`, `claimSchema`, `CHECK_KINDS`, `SCHEMA_VERSION` (`evidence/1`), `claimFingerprintV1` + `CLAIM_FINGERPRINT_VERSION` (`cfp1:` prefix is the version).
- **Receipts**: `buildVerificationReceipt`, `replayVerificationReceipt`, `tierProvenance`.
- **Graph & workflow**: `loadReceipts` / `queryReceipts` / `buildViewData` → `buildGraph` (nodes/edges with `basis`+`tier`), `buildSummary` / `buildFailures` / `buildFailureEvents` / `buildIndexes` / `filterFailureEvents` (triage), `buildGraphDiff` (regression sets + `bySubject`), `buildHistory` / `resolveFingerprintPrefix` (timelines), `buildSubjects` (status board) — plus their exported types.

Enum freezes (edge `type` / `basis` / `tier`, diff `match`, fingerprint prefix) are part of the Stable contract: **adding** values is additive; changing the meaning of an existing value is forbidden (see EVIDENCE_SPEC.md).

## Provisional surface

Low-level kernel helpers (`normalizeForCitation`, `parseNumbersFromText`, `recompute`, `canonicalizeDate`, per-check status functions) and `CHECK_REGISTRY` (the registry *data structure* may still move; the plugin concept stays).

## Examples (GitHub-only, not in the npm tarball)

- `examples/read-receipts.mjs` — load a receipt directory, print the neutral summary + subject board.
- `examples/history-query.mjs` — resolve a fingerprint prefix, print the claim timeline.
- `examples/diff-ci.mjs` — compare base/head receipt sets; exit 1 on new failures (CI gate).

Inside this repo they import `../dist/index.js`; as an external consumer, replace that with `@promptia-labs/agent-receipt`. Each file states both forms. They are smoke-tested (`test/sdk-examples.test.mjs`) so they cannot rot silently.

## Honesty

The SDK inherits every engine caveat: deterministic restatement of recorded facts only; `verified` tier only for tool-recomputed facts; `verifiedAt` is self-reported; fingerprint v1 is text identity, not semantic identity; "resolved" is not proof of a fix.
