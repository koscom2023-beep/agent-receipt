# Quickstart — one page

Contract → guard → receipt → PR comment. Everything below is local-first (no account, no server) and deterministic (no LLM judging LLMs).

## 1. Install (one line)

```bash
npm install -g @promptia-labs/agent-receipt
```

## 2. Declare the work contract (what this task may touch)

```bash
cd <your repo>
agent-receipt init --preset generic        # scaffold .agent-guard/contract.yaml
```

Edit `.agent-guard/contract.yaml`:

```yaml
scope:
  allowed_paths: ["src/**", "test/**"]
  denied_paths:  ["db/**", "billing/**"]
budget:                    # optional — warn-only observation, never a gate
  max_touched_files: 8
  max_new_files: 2
```

## 3. Turn on capture + guard (record everything, optionally block)

```bash
agent-receipt capture install --write      # Claude Code hooks → every tool call recorded
agent-receipt policy init --profile strict # standing rules + real-time BLOCK for forbidden paths
```

- Default is **warn**: forbidden-path writes are *recorded* (`guard: "warn"` in `capture.jsonl`), nothing is blocked.
- `strict` profile (or `guard: block` in `.agent-guard/policy.yaml`) turns on **real-time deny**: the write is stopped *before the tool runs*, the agent sees why, and the attempt is chained into the capture log. False positive? One line lifts it: `guard: warn`.

## 4. Close the loop

```bash
agent-receipt done             # verify against the contract + save the Work Receipt
agent-receipt commit-check     # gate before you commit
agent-receipt capture show     # what happened beyond git — guard hits, repeats, reconciliation
agent-receipt insights         # trends + repeat patterns (rereads, duplicate commands, repeated failures)
```

## 5. (CI) verify AI reports on PRs — with a receipt comment

```yaml
- uses: koscom2023-beep/agent-receipt@v0.1-verify-check-split
  with:
    report: docs/research-claims.md
    comment: "true"     # opt-in: posts/updates ONE PR comment — a mechanical projection of the sealed receipt
```

Fabricated citations/numbers/git-facts fail the job (exit 1). The comment updates in place; a fork PR with a read-only token degrades to a warning without failing anything.

## What this tool does NOT do (read before relying on it)

- **No token/time savings numbers.** Hook payloads carry no token counts — we show measured *counts* (blocked attempts, rereads, repeats), never converted savings.
- **No quality guarantee, no auto-fix.** Verification checks evidence fidelity (quote/number/date/hash/signature/link), not whether the work is good; the guard blocks paths, not bad ideas.
- **Coverage is the configured hook surface.** Uninstalled hooks, `--dangerously-skip-permissions`, Bash side effects, other machines/agents — out of scope. Receipts say what was *measured*, and they are honest about the gap (`reconciliation`, degraded markers).
