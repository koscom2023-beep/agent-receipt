# Direction — the verifiable AI-work loop (2026-07-01)

A durable decision record from four design councils. Captures **what was decided and why**, not the blow-by-blow. This is the north star for what agent-receipt grows into.

## The one product (not a kit of packages)

agent-receipt is **one CLI** with a shared verification core. New surfaces (`research`, `council`) are **subcommands of the same tool**, not separate npm packages — they reuse the existing deterministic substrate (`claimdiff` / `ledger` / `replay`). Measured continuation of the current architecture (one `bin`, no workspaces).

- **Codebase**: one repo (monorepo).
- **Distribution**: one CLI + subcommands (like git's 100+ subcommands).
- **Narrative**: one closed loop — "verifiable AI work, end to end."
- Single-responsibility lives at the **module** level, not the package level. Boundaries are drawn by `import`, not `publish`.

## The differentiator is the verification substrate — never the orchestration

Cross-verification found: the 14-expert council form and the auto-research form are **replicable by a prompt**. The only thing a prompt cannot replicate is a **deterministic, non-LLM check of a claim against an external source of truth**, plus append-only tamper-evident persistence and replay. So:

- **agent-receipt** applies it to execution — Claim ≠ Observation vs **git**.
- **research** applies it to inputs — a quote vs its **source** (webpage/snapshot = research's working tree).
- **council** applies it to decisions — each claim vs its **source / ledger**.

**Ship nothing that is only a prompt.** The product boundary is the out-of-band verification code.

## The litmus test (sorts every future request)

> **Input is a *check* → core. Input is a *judgment* → consumer.**

- `check`: git diff, hash-chain, claim-vs-source substring. → core.
- `judgment`: "was it right / good / sufficient", model selection, orchestration, prediction. → consumer (or deferred).

This keeps agent-receipt **neutral**: it observes and verifies; it never decides, recommends, orchestrates, or auto-fixes. The witness must not become the actor (or Receipt collapses to tier-C self-report and the lie-detection heart dies).

## What is NOT built here (consumer plane or deferred)

Execution/orchestration, Cost **selection** (model picking), Scheduler, Governance enforcement, Capability/Resource registries, Simulation/Digital-Twin, and most KPIs are **consumer concerns or judgments** — they belong to the agent/engine that runs work (Promptia, Claude Code, Cursor, …), not to the neutral core. Execution is a **role**, not one app: agent-receipt observes whichever engine executes.

Analytics/KPI = ledger projections (`insights` category): frozen behind real data + `SMALL_N`. Even then, only *computable* ones (Execution success, evidence rate) open cheaply; "Research accuracy / Council quality / Knowledge reuse" need a **ground-truth labeling loop nobody has designed** — they do not open on volume alone.

Cost **accounting** (record per-task cost) can be core-shaped but is **tier-C** (git can't verify cost) — must be labeled attested, never laundered into the hash-chain as a verified fact.

Promptia stays a **separate** product (a consumer), not merged.

## Dev order (the loop, closed early — not a big-bang)

1. agent-receipt = the verification substrate (near-complete).
2. `research` + `council` as subcommands → one verifiable AI-work loop.
3. Promptia as first dogfood consumer → real usage data.
4. Later, gated by real data + a labeling loop: analytics/KPI, cost accounting.
5. Everything speculative (Org/Capability/Resource/Scheduler/Simulation): added only when real usage demands it. **OS is a result, not a goal.**

## First increment (this commit)

`research verify --file <report.json>` — the deterministic citation-verification kernel: is a claim's `quotedText` a literal substring of its source? Non-LLM. Offline v1 (source = inline `sourceText` or local snapshot `sourceFile`); live re-fetch is v2. Guarantee is deliberately narrow: **citation fidelity** (the quote is really in the source), not **truth** (the claim is correct). Enforced by a `core-boundary` test: the verification core must not import the new surface.
