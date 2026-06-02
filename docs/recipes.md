# Recipes

Short, copy-paste recipes for wiring `agent-receipt` into real workflows. Command examples only — see [`CONTRACT.md`](../CONTRACT.md) for semantics.

## 1. Per-task loop (the basic loop)

```bash
agent-receipt init --preset generic     # once: scaffold .agent-guard/contract.yaml
# edit .agent-guard/contract.yaml for this task
agent-receipt prompt                     # paste into the agent
agent-receipt start                      # baseline (drops ambient untracked noise)
# … let the agent work; it pastes a completion-claim JSON …
agent-receipt verify                     # state check
agent-receipt claims --file claim.json   # reconcile the agent's claim with git
agent-receipt check                      # run tests/tsc
agent-receipt receipt                    # save the AI Work Receipt
```

## 2. git worktree sandbox

Run the agent in an isolated worktree so a bad run never touches your main checkout.

```bash
git worktree add ../task-sandbox -b task/feature-x
cd ../task-sandbox
agent-receipt init --preset generic
agent-receipt start
# … agent works here …
agent-receipt verify && agent-receipt check
# when done:
cd -
git worktree remove ../task-sandbox      # discard, or merge the branch first
```

## 3. CI gate (GitHub Actions)

`verify --json` + `check` as a required check on PRs. `verify` reads the working tree, so check out the PR diff and (optionally) leave it unstaged.

```yaml
# .github/workflows/agent-receipt.yml
name: agent-receipt
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx -y @promptia-labs/agent-receipt verify --json
      - run: npx -y @promptia-labs/agent-receipt check
```

Exit `1` (violation) or `2` (load/usage error) fails the job; `0` passes.

## 4. Local pre-push hook

`forbidden_actions` is advisory — for real push prevention use a git hook. This blocks a push when `verify` finds a violation.

```bash
# .git/hooks/pre-push  (chmod +x)
#!/bin/sh
npx -y @promptia-labs/agent-receipt verify --json >/dev/null 2>&1 || {
  echo "agent-receipt: contract violation — push blocked. Run: agent-receipt explain"
  exit 1
}
```

## 5. Diagnose a failure

```bash
agent-receipt status     # branch / baseline / current changes
agent-receipt explain    # why PASS/FAIL + magnitude + critical paths + next steps
agent-receipt doctor     # environment (git / contract / baseline)
```

## 6. Promptia daily loop

The `promptia` preset is tuned for the Promptia app (Next.js + Supabase + Vercel): it denies `.env*`, lockfiles, `supabase/migrations/**`, `vercel.json`, `.vercel/**`, `exports/**`, and `docs/arch/json/**`, while leaving `allowed_paths` broad enough for everyday source edits.

```bash
agent-receipt init --preset promptia    # once: scaffold the Promptia contract
agent-receipt lint                       # confirm the key denied paths are present
agent-receipt                            # (bare) state-aware next step — points to `start`
agent-receipt start                      # baseline before the agent works
agent-receipt prompt                     # paste into the agent (Cursor/Claude)
# … agent edits app/, src/, components/ … then pastes a completion-claim JSON …
agent-receipt                            # (bare) runs verify; on PASS suggests check/receipt/claims
agent-receipt claims --file claim.json   # reconcile the agent's claim with git
agent-receipt check                      # run tsc/lint (uncomment them in the contract)
agent-receipt receipt                    # save the AI Work Receipt
```

`agent-receipt` with no command (or `agent-receipt run`) is the everyday entry point: it inspects state and tells you the next step — `init` → `start` → `verify`, suggesting `check`/`receipt`/`claims` on PASS and `explain`/`status`/`reset` on FAIL.
