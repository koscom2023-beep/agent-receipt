# agent-receipt

> npm package **`@promptia-labs/agent-receipt`** · CLI command **`agent-receipt`**

**An AI work audit tool for coding agents — the "AI work receipt."** You write a small contract describing what an agent is allowed to touch; after the agent finishes, `agent-receipt` inspects your local **git working tree** and produces auditable evidence of whether the contract was kept. It provides **git-based evidence for compliance review — not a compliance guarantee.**

> **Hooks prevent. agent-receipt proves.**

Hooks and permission systems stop actions *before* they happen. agent-receipt does the complementary job: it produces an **AI Work Receipt** — a mechanical, after-the-fact check of what actually landed in git.

---

## Why this exists

When an AI agent edits your repo, "it said it only changed the auth module" is a claim, not a fact. agent-receipt turns the claim into a checkable receipt:

- **Hooks / permissions** are *preventive* — they block a command at the moment it runs.
- **agent-receipt** is *evidentiary* — it reads the resulting git diff and reports what was actually changed, staged, or left untracked, and whether any forbidden path was touched.

It is local-first by design:

- **No code upload.** Everything runs on your machine.
- **No API key.** There is no account and no network call.
- **Operates on your local git working tree** via ordinary git commands.

---

## AI work audit protocol (v0.8)

Beyond a single receipt, v0.8 closes the evidence loop with a short, git-native audit flow:

```
begin → (agent works) → done → explain (if FAIL)
      → audit-pack → attest (in-toto style) → commit with trailer
      → ledger appends one line → later: replay re-verifies the pack
                                   ↑ if something breaks, incident scans the trail
```

- `begin` / `done` collapse the everyday loop into two commands.
- `policy.yaml` holds standing rules (`forbidAlways` / `requireApprovalFor` / `protectAlways`); the **contract** scopes one task, the **policy** governs the project.
- `commit-check` gates the moment before you commit (it never commits for you) and prints a `Agent-Receipt:` / `Agent-Contract:` / `Agent-Policy:` trailer.
- `audit-pack` bundles the evidence; `replay --pack <dir>` re-checks it later (content hash + commit existence = **tamper-evident**, not "non-forgeable").
- `ledger.jsonl` is an append-only local trail (metadata only — no diffs/values). Flat file only.

> **Scope of evidence.** This tool is **git-working-tree based**. It cannot see `.gitignore`d files, files outside the repo, OS commands, DB writes, or external-service changes. It provides **git-based evidence for compliance review — it is not a compliance guarantee.** An AI's completion report is always a *claim*; only git state is *measured*.

Full command list: `agent-receipt help --all`.

---

## Quick Start

Install globally and run the everyday **two-command loop**:

```bash
npm install -g @promptia-labs/agent-receipt
cd <your repo>
agent-receipt init --preset promptia          # or: generic   (scaffold .agent-guard/contract.yaml)
agent-receipt policy init --profile promptia   # (optional) standing rules → .agent-guard/policy.yaml

agent-receipt begin --cursor                   # baseline + paste-in agent instructions (or --claude)
#   … the agent works …
agent-receipt done                             # verify + check + save the AI Work Receipt + summary
agent-receipt commit-check                     # gate before you commit (prints a trailer; never commits)
#   … you stage & commit yourself …
agent-receipt audit-pack                       # bundle the evidence (review-ready)
agent-receipt reset                            # clear the baseline for the next task
```

Re-verify a saved bundle later with `agent-receipt replay --pack <dir>`. Full command list: `agent-receipt help --all`.

> The lower-level commands (`start` / `prompt` / `verify` / `check` / `claims` / `receipt`) still exist — `begin` and `done` simply compose them. See **Commands** below. Feature coverage vs the design docs: [`docs/coverage.md`](docs/coverage.md); recipes (worktree/CI/hooks): [`docs/recipes.md`](docs/recipes.md).

Once installed, the CLI is invoked as `agent-receipt`. (The single-letter `ag` alias was dropped to avoid clashing with other tools.)

### Verify your install (real-use smoke check)

Before relying on it, confirm which binary/version you are actually running:

```bash
npm install -g @promptia-labs/agent-receipt@latest
agent-receipt --version        # prints the version (works with no contract / no git repo)
which agent-receipt            # which binary is on PATH
agent-receipt doctor           # shows binary path, current version, npm latest, update status
```

**Dogfood principle.** Real-world verification is done against the **global install or `npx ... @latest`** — that is what your agents actually invoke. Calling a local `node dist/cli.js` directly is **developer-internal** verification only; do not report it as real-use verification. If `doctor` reports a newer `npm latest`, run `npm install -g @promptia-labs/agent-receipt@latest`.

### Recommended `.gitignore` (tool outputs)

`init` never edits your `.gitignore` (guidance only). Add this block so `.agent-guard/` tool outputs stay out of git — keeping `verify` / `status` / `close-recon` noise-free. The contract (`contract.yaml`), policy (`policy.yaml`), and the agent README are committable and intentionally **not** ignored.

```gitignore
# agent-receipt local tool outputs
.agent-guard/session.json
.agent-guard/receipts/
.agent-guard/audit-packs/
.agent-guard/anchors/
.agent-guard/notes/
.agent-guard/decisions/
.agent-guard/keys/
.agent-guard/dashboard.html
.agent-guard/**/*.sig.json
.agent-guard/**/*.approval.json
```

---

## Core workflow

1. **Create a contract** — `agent-receipt init --preset generic` writes `.agent-guard/contract.yaml` (and an agent-facing `.agent-guard/README.md`).
2. **Brief the agent** — `agent-receipt prompt` prints a paste-in instruction block listing the allowed/denied paths and rules.
3. **Let the agent work.**
4. **Verify state** — `agent-receipt verify` checks the working tree (branch / scope / denied paths / staged / untracked / NUL). It does **not** run your tests.
5. **Run required checks** — `agent-receipt check` runs the contract's `required_checks.commands` (tsc/tests/etc.).
6. Only when **both** pass, stage the allowed files yourself and commit.

`verify` and `check` are deliberately separate: `verify` inspects *state* (fast, no command execution); `check` runs *commands*. A passing `verify` is **not** "tests passed."

If you omit `--contract`, the contract is auto-discovered (see below).

---

## Commands

| Command | What it does | Needs git repo |
|---|---|---|
| `presets` | List the built-in presets (`generic` / `nextjs-supabase` / `promptia` / `strict` / `relaxed`) with when-to-use notes. | no |
| `init --preset <generic\|nextjs-supabase\|promptia\|strict\|relaxed>` | Create `.agent-guard/contract.yaml` + `.agent-guard/README.md`. Refuses to overwrite existing files. | no |
| `draft-contract [--preset <name>] [--out <path>] [--print]` | Generate a contract draft (non-interactive): scans the repo's top-level dirs for `allowed_paths` candidates, or copies a preset. Defaults to stdout; writes only with `--out` (never overwrites). | no |
| `review` | Commit-time human checklist (read-only): scope tight enough? denied covers `.env`/lock/migrations/deploy? receipt at default location? Distinct from `lint`. | no |
| `start` | Record a baseline of the current working tree to `.agent-guard/session.json` (see Baseline mode). Refuses if a denied path is already dirty, or if a session already exists. | yes |
| `status` | Print a read-only summary: contract scope, baseline (session) state, branch, current changes. | yes |
| `reset` | Remove the baseline `.agent-guard/session.json` (leaves `contract.yaml`/`README.md` intact). | no |
| `verify [--json]` | State checks only (no commands run). Human report, or a stable one-line JSON with `--json`. | yes |
| `check` | Run `required_checks.commands`; all must match their `required_exit`. | no |
| `prompt [--cursor\|--claude]` | Print a paste-in instruction block for the agent. Variants differ only in header/tone; the completion-claim JSON is identical (so `claims` works either way). | no |
| `report [--type developer\|client\|audit] [--out <file>]` | Run `verify` and write a Markdown report — `developer` (default, detailed), `client` (trimmed), or `audit` (contract/policy/receipt/environment-centric). | yes |
| `receipt [--format json\|md\|client-md] [--redact] [--out <file>]` | Run `verify` + `check` and save an **AI Work Receipt** to `.agent-guard/receipts/` (change magnitude, critical-path attestation, environment/provenance, integrity `contentHash`). `client-md` is a trimmed client-facing render; `--redact` best-effort masks secret-looking values. Saving outside the default dir warns (verify won't exclude it). | yes |
| `receipts [--latest\|--cat\|--dir]` | Find saved receipts under `.agent-guard/receipts/`: list newest-first (default), `--latest` summary (ok/contractId/timestamp/contentHash/magnitude), `--cat` latest content, `--dir` directory path. No receipts → guidance, exit `0`. | no |
| `mode` | Read-only explanation of whether you're in **task** or **daily** flow (contract/session/baseline state + recommended next command). No file written. | no |
| `claims --file <claim.json>` | Compare an agent's completion report (JSON) against the actual git state — surfaces hidden/over-claimed changes as **AI said / Git says**. Mismatch → exit `1`. | yes |
| `explain` | Explain *why* the tree is PASS/FAIL (branch / scope / denied / magnitude / critical paths) with recovery hints. Exit mirrors `verify`. | yes |
| `audit [--json]` | Local audit summary over `.agent-guard/receipts/`: count, latest, PASS/FAIL, critical-touched, unique `contentHash`. Read-only (no auto-append). | no |
| `dashboard [--out <path>]` | Render a single self-contained static HTML (no CDN/network) of all receipts. Default `.agent-guard/dashboard.html` (excluded by `verify`). | no |
| `keys init` | Generate an ed25519 key pair under `.agent-guard/keys/` (Node built-in crypto). Warns to gitignore the key dir (does not edit `.gitignore`). | no |
| `sign --receipt <path>` | Sign a receipt's bytes (ed25519); writes sidecar `<receipt>.sig.json`. | no |
| `verify-signature --receipt <path>` | Verify the sidecar signature with the public key. PASS → `0`, FAIL → `1`. | no |
| `approve --receipt <path> [--note <text>]` | Record a local approval sidecar `<receipt>.approval.json` (approver from git config, timestamp, contentHash, note). No git commit, no network. | no |
| `approvals` | List local approval sidecars. | no |
| `export --format <slack\|json\|github-pr\|otel\|langfuse> --receipt <path>` | Print an external-transport payload **preview to stdout only** (Slack blocks / summary JSON / PR-comment markdown / OTLP log / Langfuse trace). Never POSTs; no token/URL. | no |
| `pre` | Pre-start check (correct branch, nothing already staged). | yes |
| `doctor` | Environment/setup health check (git / contract / baseline). | no |
| `lint` | Advisory contract-quality checks (scope / denied / forbidden_actions). | no |
| `help` | Usage. | no |
| `run` | Alias for the no-args single-command routing below. | — |
| *(no args)* | Single-command routing: inspects state and points to the next step (`init` / `start` / `check`), or runs `verify` when a baseline exists; on PASS it suggests `check` / `receipt` / `claims`, on FAIL it suggests `explain` / `status` / `reset`. | — |

### Audit workflow commands (v0.8)

| Command | What it does | Needs git repo |
|---|---|---|
| `begin [--cursor\|--claude\|--generic]` | Start a task in one step: check `policy`, record the baseline (`start`), and print the paste-in agent instructions (`prompt`). | yes |
| `done [--claim <c.json>] [--client] [--ledger]` | Finish a task in one step: `verify` + `check`, save the receipt, summarize, optionally reconcile a `--claim` and append to the ledger. | yes |
| `policy init [--profile <solo-founder\|vibe-coder\|agency-client\|team-strict\|promptia>] \| check \| show` | Manage `.agent-guard/policy.yaml` — **standing** project rules (`forbidAlways` / `requireApprovalFor` / `protectAlways` / `requireReceipt` …). The contract scopes one task; the policy governs the project. | check: yes |
| `commit-check` | Gate just before you commit: `verify` PASS, `check` PASS, a receipt matching the current change, and policy rules satisfied. **Never commits.** On pass, prints an `Agent-Receipt:` / `Agent-Contract:` / `Agent-Policy:` commit trailer. | yes |
| `trailer` | Print the commit trailer only (hashes/paths, no values) to paste into a commit message. | yes |
| `audit-pack [--out <dir>] [--claim <c.json>] [--redact] [--ledger]` | Bundle the evidence (contract, policy, receipt, claim+verify, approval, signature, environment, manifest) into `.agent-guard/audit-packs/<ts>/`. A review bundle — **tamper-evident, not a non-forgeable proof.** | yes |
| `replay --pack <dir>` (alias `verify-pack`) | Re-verify a saved audit-pack against the current repo: recompute the receipt `contentHash`, confirm the commit exists. Detects tampering. Cannot reproduce external DB/OS effects. | yes |
| `ledger [--json]` · `ledger rebuild` | Append-only local trail `.agent-guard/ledger.jsonl` — one metadata line per receipt (no diffs/values). `rebuild` regenerates it from `receipts/`. | no |
| `attest --receipt <p> \| --pack <dir>` | Emit an in-toto **style** Statement (draft) to stdout — provenance over the receipt + commit. Not an SLSA-level claim; tamper-evident, not non-forgeable. | no |
| `anchor [--receipt <p>]` · `anchor --upload` | Wrap a receipt in a DSSE-signed in-toto Statement (auto-generates an ed25519 key) and either print Rekor-registration instructions (default, offline) or, with **`--upload`**, register it to the public **Rekor** transparency log in one command (Node `fetch` + built-in crypto — no external tools), then write a `<receipt>.rekor.json` sidecar. Seals **time & existence** via a third party; **not** a keyless identity proof. | no |
| `incident [--since <n>]` | Scan recent receipts/ledger for failures, critical-path changes, missing approvals, last PASS. Read-only; no auto-recovery, no scoring. | no |

### Convenience & release commands (v0.9)

These shorten the real-world loop. **None of them run git, npm, or any deploy** — they print paste-in blocks or read-only analysis. `verify --json`'s 14 keys are unchanged. **Git is the only evidence**; `note`, `release-check`, `policy mode`, and a claim's `modeClaims`/`externalActions` are **advisory / self-report — never PASS/FAIL inputs.**

| Command | What it does | Needs git repo |
|---|---|---|
| `begin --kind <recon\|implementation\|docs\|test\|measure-first\|observe-only\|release-check>` | Tag the session's *kind* (stored in `session.json` / receipt sidecar — never in the 14 keys). Prints kind-specific operating rules + end command, and a strong warning if a baseline already exists (recon→implementation transitions must `reset` first). | yes |
| `close-recon` | Close a read-only recon session in one step. **Only when there are zero changes** (touched/staged/untracked/denied/out-of-scope all 0): save a receipt, build an audit-pack, and `reset`. Refuses (no reset) if anything changed, or if the session is `kind=implementation`. | yes |
| `prepare-commit [--message <m>] [--include-linked-tests]` | Generate a safe copy-paste commit block — `git add` candidates + message + `Agent-Receipt` trailer — with the **commit block and reset block physically separated** (no `EOF`+`reset` on one line). Never commits. Suppresses the block on denied / true out-of-scope / branch mismatch / NUL. | yes |
| `finish [--message <m>] [--client]` | Implementation wrap-up in one step: `done` → `commit-check` → `audit-pack` → commit block, with per-stage PASS/FAIL labels and a single "next command" on failure. No auto add/commit/reset/push. | yes |
| `note --type <recon\|contract-draft\|no-code-decision\|next-options> [--message <m>]` | Record a no-code recon/decision as a **note/claim — not git-verified evidence** (`.agent-guard/notes/` or `/decisions/`, pinned to `headHash`). Included in audit-packs *as a user memo*. Tool output — excluded from `verify`. | yes |
| `release-check --base <ref> [--failed-tests <file>] [--observe <event>]` | Pre-deploy **read-only, advisory** analysis: base/head, ahead/behind, rollbackBase, changed files, commits, a heuristic risk class (labeled — not a score), failed∩changed (heuristic, only if the file is given), and post-deploy events to watch. **Never push/deploy/checkout/reset; does not approve a deploy** — a human decides. | yes |
| `next` | Recommend the single next command for the current state. | (discovers) |

Contracts may also declare `linked_test_paths` / `expected_linked_tests` (optional) so a guard test outside `allowed_paths` is shown as a *linked guard test (human-confirm)* in `commit-check`/`prepare-commit` — `verify`'s `outOfScope` meaning is unchanged. Policies may set `mode: measure_first | observe_only` to print a self-report checklist in `commit-check` (display only — the tool sees git diffs, not intent).

### Contract discovery

When `--contract` / `-c` is not given, the first existing file wins, in this order:

1. `--contract` / `-c` value (explicit; auto-discovery is skipped entirely)
2. `.agent-guard/contract.yaml`
3. `.agent-guard/contract.json`
4. `agent-guard.yaml`
5. `agent-guard.json`

### Exit codes

- `0` — pass
- `1` — violation (`verify` state violation, `check` command failure, `pre` problem)
- `2` — loading/usage error (missing/unreadable contract, schema error, not a git repo, unknown command/preset)

> Wiring it into a worktree sandbox, CI, or a pre-push hook? See [`docs/recipes.md`](docs/recipes.md).

---

## Baseline mode (`start`)

Real repos are rarely clean — there are often pre-existing untracked files (docs, exports, scratch) unrelated to the current task. Without a baseline, `verify` flags all of them, drowning the real signal.

`agent-receipt start` records the working tree at the start of a task into `.agent-guard/session.json` (a baseline). After that:

- **Ambient noise is removed.** Files that were already unstaged/staged/untracked at `start` are excluded from scope checks — `verify` reports only what changed *since* the baseline.
- **New violations are still caught.** A new out-of-scope or denied file created after `start` is flagged normally.
- **`denied_paths` is never hidden by a baseline.** Denied matching runs against the **full** current working tree, not the baseline-relative subset. You cannot bury a denied path by baselining it.
- **Tool-generated outputs are ignored by `verify`** — `.agent-guard/session.json`, `receipts/`, `keys/`, `audit-packs/`, `ledger.jsonl`, and `dashboard.html`. The rest of `.agent-guard/` (e.g. `contract.yaml`, `policy.yaml`) is treated normally.
- **Stale baselines are ignored, safely.** If you switch branches, or the recorded `baselineHead` is no longer an ancestor of `HEAD`, the baseline is dropped and `verify` falls back to full-tree checking (noisier, but it never hides changes). Run `agent-receipt reset` then `agent-receipt start` to re-baseline. Use `agent-receipt status` to see the current baseline state.

### `start` refuses when a denied path is already dirty

If any already-dirty file (unstaged/staged/untracked) matches `denied_paths`, **`start` fails and writes no session.** Baselining a dirty denied path would "bury" a dangerous change as if it had always been there.

**This is a safety condition, not something to work around.** Resolve it by one of:

- clean up / `git add` + commit / gitignore the offending untracked files, or
- narrow the `denied_paths` globs so they don't overlap pre-existing ambient files.

There is deliberately **no flag to bypass this check** — refusing is the correct behavior.

> Baseline mode compares **path sets, not content hashes.** If a file already existed as untracked at `start`, later content edits to that same untracked path may not be detected — unless it matches `denied_paths`, which is always checked against the full tree.

---

## Contract example

YAML and JSON are parsed by the same schema. The full schema is documented in [`CONTRACT.md`](CONTRACT.md) (source of truth: `src/schema.ts`).

```yaml
id: example
title: example patch-only guard
mode: patch_only
branch:
  expected: main
scope:
  # If allowed_paths is empty, positive scope-checking is disabled — protect via denied_paths instead.
  allowed_paths:
    - "src/**"
  denied_paths:
    - ".env*"
    - "package.json"
forbidden_actions:        # advisory only — NOT mechanically enforced (see CONTRACT.md §7)
  - push
  - deploy
required_checks:
  commands:
    - name: typecheck
      command: "npx tsc --noEmit"
      required_exit: 0
git:
  require_no_staged_untracked: false       # default
  require_only_allowed_files_staged: false # default
  require_no_denied_path_diff: true        # default (on)
  require_no_push: false                   # default
```

The minimal valid contract is just `id` plus a `scope` key:

```yaml
id: minimal
scope: {}
```

`scope` is **required** (even if empty); only `scope.allowed_paths` / `scope.denied_paths` default to `[]`.

---

## Scaffolding a contract (`init`)

`agent-receipt init --preset <generic|nextjs-supabase>` creates a starter setup so you don't write a contract from scratch (it needs neither a contract nor a git repo):

- **`.agent-guard/contract.yaml`** — a starter contract from the chosen preset (see Presets below).
- **`.agent-guard/README.md`** — a short agent-facing note describing the rules and how to run `verify` / `check`.

After it runs, the new `contract.yaml` is auto-discovered by every other command, so you can run `agent-receipt verify` with no `--contract`.

**Safety: `init` never overwrites.** If either `.agent-guard/contract.yaml` or `.agent-guard/README.md` already exists, `init` fails (exit `1`) and writes nothing — remove the existing file(s) first if you really want to regenerate. An unknown or missing `--preset` is a usage error (exit `2`).

Typical flow:

```bash
npx agent-receipt init --preset generic   # scaffold .agent-guard/{contract.yaml,README.md}
# edit .agent-guard/contract.yaml for your project
npx agent-receipt start                    # (optional) record a baseline — see Baseline mode
# … let the agent work …
npx agent-receipt verify                   # state checks (auto-discovers the contract)
npx agent-receipt check                    # run required_checks.commands
```

In short: **`init` creates the contract; `start` (optional) records a baseline on top of it; `verify` / `check` evaluate against it.**

> **Note — running `verify` before `start`:** the files `init` writes (`.agent-guard/contract.yaml`, `.agent-guard/README.md`) are themselves untracked, and `verify` does **not** exclude them — only **tool-generated outputs** (`session.json`, `receipts/`, `keys/`, `audit-packs/`, `ledger.jsonl`, `dashboard.html`) are excluded. So with a restrictive `allowed_paths`, running `verify` *before* `start` may report them as `outOfScope`. **This is normal.** Avoid it by following the recommended order (`init` → edit → **`start`** → `verify`/`check`, which baselines them away), or by adding `.agent-guard/contract.yaml` / `.agent-guard/README.md` to `allowed_paths` (or committing / gitignoring them).

---

## Presets

- **`generic`** — a starter patch-only contract: empty `allowed_paths` with protective `denied_paths` (`.env*`, key/cert files).
- **`nextjs-supabase`** — adds denied paths typical for a Next.js + Supabase app (migrations, lockfiles, `vercel.json`) and a `tsc --noEmit` check.
- **`promptia`** — tuned for the Promptia app (Next.js + Supabase + Vercel). Denies `.env*`, lockfiles, `supabase/migrations/**`, `vercel.json`, `.vercel/**`, `exports/**`, and `docs/arch/json/**`; uses a **broad `allowed_paths`** (`app/`, `src/`, `components/`, `lib/`, …) so everyday source edits pass; `required_checks.commands` is left empty with commented examples (uncomment `pnpm tsc --noEmit` / `pnpm lint` for your project). `lint` and `doctor` recognize this preset and warn if a key denied path is missing.
- **`strict`** — for risky changes or external-contractor review: narrow `allowed_paths`, strong `denied_paths`, and `require_no_staged_untracked` + `require_only_allowed_files_staged` turned on, plus a `tsc` check.
- **`relaxed`** — for exploration/prototyping: `denied_paths`-only (empty `allowed_paths`, positive scope off), tolerant of ambient untracked noise.

All five are starting points — edit the generated `.agent-guard/contract.yaml` for your project. Run `agent-receipt presets` to list them, or `agent-receipt draft-contract` to generate a repo-scanned draft.

---

## What agent-receipt catches

Run by `verify` against the combined set of unstaged + staged + untracked changes:

- Files changed **outside** `allowed_paths` (when `allowed_paths` is non-empty)
- Changes to **`denied_paths`**
- Out-of-scope files **staged** (when `require_only_allowed_files_staged`)
- **Untracked** files present (when `require_no_staged_untracked`)
- **NUL bytes** in declared paths (corrupted files)
- Wrong branch (vs `branch.expected`)

Run by `check`:

- `required_checks.commands` whose exit code doesn't match `required_exit`

---

## What agent-receipt does **not** do

Read this before relying on it:

- **Not a real-time blocker.** It runs *after* the agent works, on git state. It does not intercept or block destructive shell commands as they happen.
- **Not a security scanner or platform.** No vulnerability detection.
- **No code-quality or security review.** It does not read your code for bugs.
- **No semantic / AST review.** It checks *which files changed*, not *whether the change is good*.
- **`forbidden_actions` is advisory.** It is surfaced in `prompt` output but is **not** mechanically enforced by `verify`. Real prevention comes from `denied_paths` + git checks + human review (and, for push, a git pre-push hook).
- **Push is only reported, not blocked.** `verify` shows ahead/behind vs `origin/main` for information.

---

## JSON output (`verify --json`)

For CI/automation, `verify --json` prints a single stable JSON line to stdout and suppresses the human note. The key set is fixed:

```json
{"ok":true,"contractId":"example","title":null,"branch":{"current":"main","expected":null,"ok":true},"touched":[],"staged":[],"untracked":[],"outOfScope":[],"deniedHits":[],"stagedOutOfScope":[],"nulBad":[],"violations":[],"headHash":"...","aheadBehind":null}
```

- Optional values (`title`, `branch.expected`, `aheadBehind`) keep their key with a `null` value.
- On a `2` error there is no JSON on stdout (message goes to stderr).
- Depend on **`ok` and the exit code**, not on incidental field shapes.

---

## Completion claims (`claims`)

An agent's "I changed only X, tests pass" is a *claim*. `agent-receipt claims --file <claim.json>` checks that claim against the **actual git state** — it never trusts the claim itself. The most useful catch is a change the agent *didn't* mention.

The claim file is plain JSON; every field is optional and only provided fields are compared:

```json
{
  "changedFiles": ["src/auth.ts"],
  "newFiles": [],
  "deniedHits": [],
  "tests": true,
  "summary": "fixed the token refresh"
}
```

- `changedFiles` / `newFiles` / `deniedHits` are compared (as sets) to git's actual touched / untracked / denied paths.
- `tests` (boolean) is compared to running `check` (the contract's `required_checks.commands`).
- `summary` is informational only (echoed, not verified).
- Exit `0` = claim matches git · `1` = mismatch · `2` = file missing / not valid JSON.

`agent-receipt prompt` already tells the agent to emit exactly this JSON, so the loop is: brief with `prompt` → agent works → agent pastes the claim → `claims --file` reconciles it with git.

## Capture & share-proof (0.11 alpha)

Two newer commands extend receipts **beyond the git working tree**.

**`capture` — what the agent did that git can't see.** Wire it into Claude Code's `PreToolUse`/`PostToolUse` hooks and it records, append-only, the agent's *actions* — reading a `.env`, calling an external host, creating-then-deleting a file — none of which leave a git trace. **Values are never stored** (paths / hosts / classification only, redacted). It never blocks (evidence, not a gate).

```bash
agent-receipt capture install            # preview the hooks snippet (no file change)
agent-receipt capture install --write    # merge hooks into ./.claude/settings.json (idempotent, preserves existing)
agent-receipt capture show               # git saw: N  ⟷  actions recorded: M  (+ git-changed paths with no capture record)
agent-receipt capture verify             # hash-chain integrity check (tamper / deletion / reorder / gap)
```

When a capture log exists, `done` / `receipt` embed an `actions` / `actionsSummary` block in the receipt — **additive**: the 14-key `verify --json` and the existing `contentHash` are unchanged, and receipts produced without capture are byte-identical. `agent-receipt begin` clears the log for a fresh audit boundary.

**Completeness — what it can and can't promise.** The capture log is a hash-chain (each record carries `seq` + `prevHash` + `entryHash`), so `capture verify` detects tampering, deletion, reorder, and internal gaps; a failed ingest writes an explicit `capture-degraded` marker instead of silently dropping. `share-proof` / `capture show` also surface **git-changed paths that have no capture record** (the hook blind spot) and the captured tool surface. It is **honest about its ceiling**: proving *every* action was captured is impossible for a single local observer, so the claim is **tamper-evident & gap-evident within the configured hook surface — not "complete."** Out of scope (known blind spots): tail-truncation, `--dangerously-skip-permissions` (hooks fully off), sub-agent / MCP / pipe / OS-level actions, concurrent-hook races.

**`share-proof` — a one-page evidence file for your client.** Renders a receipt as a self-contained HTML page (no network, no external resources) you can send to a client: scope result, change magnitude, beyond-git actions, and the integrity hash.

```bash
agent-receipt share-proof                 # render the latest saved receipt
agent-receipt share-proof --receipt <p>   # render a specific saved receipt
```

**`anchor` — a third-party seal (Rekor transparency log).** A local receipt is *your* statement about *your* work — useful, but self-issued. `anchor --upload` wraps the receipt in a DSSE-signed in-toto Statement and registers its hash to the public **Rekor** transparency log, so a client can confirm **the receipt existed at that time without trusting you**. One command, no external tools (Node `fetch` + built-in crypto); it auto-generates an ed25519 key on first use.

```bash
agent-receipt anchor                       # offline: build the DSSE bundle + print how to register
agent-receipt anchor --upload              # one command: sign + register to Rekor + write the sidecar
```

On success it writes a `<receipt>.rekor.json` sidecar next to the receipt (entry UUID, logIndex, verification URL). **`share-proof` then auto-embeds a "Verify in the public transparency log" link** — a receipt with no sidecar renders byte-identically to before. The link is *click-only* (an `href`, never an auto-loaded resource), so opening the proof still leaks nothing.

> Honest scope: **git-based evidence, tamper-evident — not non-forgeable, and not a compliance guarantee.** Capture currently adapts Claude Code hooks (single agent). A receipt may optionally be anchored to the public Rekor log (`anchor`, above) — that seals **time & existence** via a third party, but is **not** a keyless (identity) proof. Cloud / hosted SaaS verification pages remain out of scope.

---

## Local-first / privacy

- Runs entirely locally; no code or diff leaves your machine.
- No API key, no account, no telemetry, no network requests.
- Uses your installed `git` to read the working tree.

---

## Package status

Current version **`0.10.0`** (`@promptia-labs/agent-receipt`). The 0.9.x line added convenience/integration (`begin --kind`, `close-recon`, `prepare-commit`/`finish`, `note`, `release-check`, `next`) and git-evidence/advisory separation; **`0.10.0`** added `schemaVersion`, provenance, hash-chain ledger, content hashing, and strict-redact. Cloud/SaaS, real Slack/webhook transport, remote approval, and any "compliance guarantee" remain intentionally out of scope. Feature coverage vs the design docs: [`docs/coverage.md`](docs/coverage.md).

Version ladder: `0.7.0` (work receipts) → `0.8.0` (AI work audit protocol) → `0.9.x` (convenience + dogfood fixes) → **`0.10.0` (integrity: schemaVersion / provenance / hash-chain ledger)** → **`0.11.0` (focused alpha: tightened surface + `capture` — beyond-git action trace + `anchor` — third-party Rekor seal & in-proof verification link; in progress).** A feature-maximal `1.0.0` is **deferred** in favor of a focused product — see [`docs/VERSION-DECISION-2026-06-29.md`](docs/VERSION-DECISION-2026-06-29.md).

For local development:

```bash
npm run build           # emit dist/  (also runs via prepack on npm pack/publish)
node dist/cli.js verify --contract .agent-guard/contract.yaml
# or, without building:
npm run guard -- verify --contract .agent-guard/contract.yaml
```

> The CLI output now prints the `agent-receipt` name. The control directory `.agent-guard/` and the auto-discovered filenames `agent-guard.yaml` / `agent-guard.json` are **intentionally kept** (renaming them would break existing setups). See [`docs/publish-prep.md`](docs/publish-prep.md).

---

## Contract schema

The authoritative schema — every field, default, and the YAML/JSON parsing rules — lives in [`CONTRACT.md`](CONTRACT.md). The source of truth is `src/schema.ts`; if this README and `CONTRACT.md` ever disagree, `CONTRACT.md` (and the code) win.

---

## Feedback

This package is **actively maintained**, and your input shapes it. With a small but real user base, a few thoughtful notes are worth more than any download count.

If you've tried `agent-receipt` — even once, or on a real project — I'd love to hear:

- What was confusing — in the CLI or the docs?
- Which feature is missing for your workflow?
- Would you recommend it to someone else? Why, or why not?

Please **[open an Issue](../../issues)** (bugs, rough edges, ideas) or **start a [Discussion](../../discussions)** (questions, general feedback). Even a one-line reply genuinely helps. Thank you for trying it.
