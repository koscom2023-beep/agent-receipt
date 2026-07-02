# Direction — the verifiable AI-work loop (2026-07-01)

A durable decision record from the design councils. Captures **what was decided and why**, not the blow-by-blow. This is the north star for what agent-receipt grows into.

## Identity: AI Audit Infrastructure

agent-receipt is not an AI agent framework, orchestrator, or assistant. Its identity is **AI Audit Infrastructure** — the independent layer that makes AI work *trustworthy*, not *smarter*. The product center is **Evidence** (Evidence → Verification → Replay → Audit as a system), of which the Receipt is one artifact.

Five phases (current work in **bold**): **P1 Receipt/Replay/Ledger/Research-verify/Council** → **P3 Deterministic Verification Engine** (citation ✓ · number/calculation ✓ · date/link/document next) → P2 Evidence Graph (claims → sources → DAG) → P4 AI Audit SDK (any agent emits receipts) → P5 AI Audit Platform (enterprise / auditor / regulator share one receipt).

**Honest "why us" (investment-scrutiny, not a yes-council).** The independence argument — a vendor auditing its own model's output is self-audit, invalid in accounting — answers *why not OpenAI/Anthropic*, **not** *why us*: an independent audit firm, another startup, or an open standard could also be independent. Our defensible "why us" is narrower and must be earned: (a) the **breadth + depth of the deterministic kernel** (citation, number, calculation, date, link, document — git-native, model-agnostic, no-cloud — a library that takes time and range to match), (b) first-mover on the artifact, (c) **a first real user**. The moat is also *contingent* on regulation or strong multi-vendor distrust, neither proven to pay today. So the work is: widen the kernel (P3) and get the first user — the code does not prove this; the market does.

## The moat (three parts; only two are code)

No single verifier is a moat — a citation or number checker is a week of work for anyone. The moat is three things together, as Git's **ecosystem and standardization** outgrew Git itself:

1. **Widest deterministic kernel** — citation ✓ · number ✓ · date ✓ · link ✓ → then **file · hash · formula · version · dependency · signature · artifact · replay**. Breadth is a real barrier: matching a broad, git-native, model-agnostic, no-cloud kernel takes range and time.
2. **An adoptable versioned format** — one shared, versioned semantics for a verified claim (`evidence/1`). `evaluateClaim` is that single semantics: research and council both call it, so **the code is the format spec**, not a doc. We do **not** call it a "standard" — a standard is *adopted*, not *declared*; we design a clean, versioned, documented format that *can be* adopted. (The engine is a **check registry / plugin system**, not an "Evidence VM" — that term implies a DSL / opcodes / execution state we do not have. VM is a future goal, not today.)
3. **Ecosystem adoption** — not code. This is the market's to grant.

Maturity (honest): **L1** checker → **L2** Evidence Kernel → **L3** versioned Spec → **L4** registry / plugin → **L5** Verification Receipt + Provenance + replay + signature ← **now** → **L6** Evidence Graph — a relationship + consumption layer over accumulated receipts (`graph query` filters by commit/input/model; `graph view --format json` returns `{ summary, indexes, failures, receipts }` — a Dashboard `summary`, a **Failure Index** (`byCheck` / `byModel` / `bySubject` / `byCommit` / `byReason`, so a consumer answers "which project has the most citation mismatches" in one lookup, no receipt traversal), `failures`, and per-claim **Reason objects** [check → reason → **evidence (expected ↔ actual, produced deterministically by the kernel)** → hint]; the static `graph view` HTML is a **failure-first Evidence Browser** — Dashboard → Failures tabs (byCheck / byModel / bySubject / byCommit / byReason) → Reason (with expected ↔ actual evidence) → Affected Claim → the Receipt itself as the *last* drill-down). **The edge layer now exists**: `graph view --format json` includes `graph: { nodes, edges }` — nodes are Receipt / Claim / Check, edges are `asserts` / `checked_by` (receipt-internal structure, read directly from the file), `same_input` (same `input.sha256` — tier `verified` **only when both input files were re-hashed by this tool and match** (`inputMatch`); otherwise `reported`, because a stated hash is a self-report), `same_commit` (self-reported commit — always `reported`), and `reverifies` (same input verified again later — **always `reported`**, since `verifiedAt` is a caller-injected timestamp with no recomputation path; direction omitted on ties/unparseable times). A same-(input·tool-version·verdict) re-run folds into one node by design (deterministic `receiptId`), so `reverifies` only appears when verdict or tool version changed — the fold itself is preserved honestly (`occurrences` + `verifiedAtAll`, node dated to the latest run, missing `receiptId` never folded). Receipts whose seal fails replay are flagged `tampered` on the node, not hidden. Every edge is a deterministic restatement of recorded facts (codepoint ordering, `Date.parse`-canonicalized times — no locale/filesystem dependence) and carries a `basis` (what fact produced it) and a `tier`. The consumption layer on top: `graph failures` (triage), `graph diff` (regression sets, exit 1 on new failures, per-subject deltas), `graph history --claim|--input|--subject` (timelines via `cfp1:` fingerprints), `graph subjects` (neutral status board). Honest naming: with edges real, the name **Evidence Graph** is earned. We deliberately do **not** emit `derived_from` — re-verification is not proof of derivation; a true lineage edge waits for an explicit declaration field in the receipt. → **L7** SDK — surface formalized: Stable/Provisional tiers with a semver promise + smoke-tested runnable examples (docs/SDK.md; adoption still the market's) → **L8** *adoptable* ecosystem foundation (RFC / spec governance / compatibility suite / certification). **L8 is not code** — we can build everything that *enables* adoption, but adoption itself is an external result the market grants. Honest progress: the code side of L1–L7 is built and L8 is prepared (0.12.0); what remains of L8 — adoption, governance, certification — is non-code and market-granted. "Evidence VM" and "industry standard" stay future labels.

Honest: parts 1–2 are buildable now; part 3 is not, and a vendor with distribution (e.g. bundling a checker into their product) could try to define the format first. So the code job is: **widen the kernel and keep one clean shared format** — necessary, not sufficient. (Long-term hypothesis, not a plan: "AI Financial Statements" — firms submitting auditable Evidence of AI decisions/code/work to independent auditors. Whether that market forms is a bet.)

## The one product (not a kit of packages)

agent-receipt is **one CLI** with a shared verification core. New surfaces (`research`, `council`) are **subcommands of the same tool**, not separate npm packages — they reuse the existing deterministic substrate (`claimdiff` / `ledger` / `replay`). Measured continuation of the current architecture (one `bin`, no workspaces).

- **Codebase**: one repo (monorepo).
- **Distribution**: one CLI + subcommands (like git's 100+ subcommands).
- **Narrative**: one closed loop — "verifiable AI work, end to end."
- Single-responsibility lives at the **module** level, not the package level. Boundaries are drawn by `import`, not `publish`.

## The Evidence Engine — the differentiator, never the orchestration

The core is not just a verifier. It is an **Evidence Engine**: `capture → normalize → verify → reconcile → ledger → replay`. Verification is one stage. Every surface — `research verify`, `council verify`, and future `eval verify` — reuses the same shared **Evidence Kernel** (`evidencekernel.ts`), a set of pure, non-LLM checks. That shared kernel is the asset; the surfaces are thin skins over it.

Cross-verification found: the 14-expert council form and the auto-research form are **replicable by a prompt**. The only thing a prompt cannot replicate is a **deterministic, non-LLM check of a claim against an external source of truth**, plus append-only tamper-evident persistence and replay. So:

- **agent-receipt** applies it to execution — Claim ≠ Observation vs **git**.
- **research** applies it to inputs — a quote vs its **source** (webpage/snapshot = research's working tree).
- **council** applies it to decisions — each decision's supporting claim vs its **source**, appended to a hash-chained **DecisionLog**.

**Council is a Compiler, not a verifier.** The compiling — running experts, extracting claims, deduping, contradiction detection, producing a **DecisionRecord** — is judgment/orchestration and lives in the **consumer** (the meeting runner). The core only **verifies** the resulting DecisionRecord and seals it. `Research → DecisionRecord (compiled by a consumer) → Evidence Kernel verify → DecisionLog`.

**Ship nothing that is only a prompt.** The product boundary is the out-of-band verification code.

## The litmus test (sorts every future request)

> **Input is a *check* → core. Input is a *judgment* → consumer.**

- `check`: git diff, hash-chain, claim-vs-source substring. → core.
- `judgment`: "was it right / good / sufficient", model selection, orchestration, prediction. → consumer (or deferred).

This keeps agent-receipt **neutral**: it observes and verifies; it never decides, recommends, orchestrates, or auto-fixes. The witness must not become the actor (or Receipt collapses to tier-C self-report and the lie-detection heart dies).

## What is NOT built here (consumer plane or deferred)

Execution/orchestration, Cost **selection** (model picking), Scheduler, Governance enforcement, Capability/Resource registries, Simulation/Digital-Twin, and most KPIs are **consumer concerns or judgments** — they belong to the agent/engine that runs work (Claude Code, Cursor, or any generation engine), not to the neutral core. Execution is a **role**, not one app: agent-receipt observes whichever engine executes.

**Intelligence is always-on; Analytics is later.** They are different. *Intelligence* = neutral pattern observation available from the first receipt (e.g. `insights` already flags a command that fails repeatedly — recurrence, no prediction, no judgment). That is a check and stays in the core, gated only by `SMALL_N`. *Analytics* = dashboards / charts / rich statistics — a later, heavier consumer surface. The rule/lesson **generated** from a pattern ("so add a check next time") is judgment → consumer. So: observe patterns always (neutral); build dashboards later; never let the core generate the rule.

KPI = ledger projections (`insights` category), frozen behind real data + `SMALL_N`. Only *computable* ones (Execution success, evidence rate) open cheaply; "Research accuracy / Council quality / Knowledge reuse" need a **ground-truth labeling loop nobody has designed** — they do not open on volume alone.

Cost **accounting** (record per-task cost) can be core-shaped but is **tier-C** (git can't verify cost) — must be labeled attested, never laundered into the hash-chain as a verified fact.

The neutral core is **never merged** into a generation engine or consumer app — those stay separate products. agent-receipt is engine-agnostic; it is not tied to any one consumer.

## Dev order (the loop, closed early — not a big-bang)

1. agent-receipt = the verification substrate (near-complete).
2. `research` + `council` as subcommands → one verifiable AI-work loop.
3. A dogfood consumer → real usage data. (Which app the owner wires for dogfood is incidental; it is not part of agent-receipt's identity, which stays neutral and engine-agnostic.)
4. Later, gated by real data + a labeling loop: analytics/KPI, cost accounting.
5. Everything speculative (Org/Capability/Resource/Scheduler/Simulation): added only when real usage demands it. **OS is a result, not a goal.**

## First increment (this commit)

`research verify --file <report.json>` — the deterministic citation-verification kernel: is a claim's `quotedText` a literal substring of its source? Non-LLM. Offline v1 (source = inline `sourceText` or local snapshot `sourceFile`); live re-fetch is v2. Guarantee is deliberately narrow: **citation fidelity** (the quote is really in the source), not **truth** (the claim is correct). Enforced by a `core-boundary` test: the verification core must not import the new surface. `council verify` follows the same shape for decisions, adding a hash-chained `DecisionLog`.

## Honest limits

- **Determinism is necessary, not sufficient.** A substring/hash/diff/recompute check is implementable by anyone in time. The durable value is not any single check — it is the **loop** (Evidence → Decision → Execution → Receipt → learning) plus two things a vertically-integrated model vendor structurally cannot offer: **audit independence** (they verify their own model's output — self-audit) and **model-agnostic** coverage (we verify any vendor's agent). Lead with those, not with "deterministic" or "local" alone.
- **The real test is the market, not the code.** Do teams pay to solve this? Do regulated / multi-vendor orgs adopt an independent verification layer? Does a first user beyond the owner's own dogfood choose it freely? Until a real customer says yes, the architecture is sound but unproven.
