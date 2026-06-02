# agent-guard

**A task-level work-contract verifier for AI coding agents.** You write a small contract describing what an agent is allowed to touch; after the agent finishes, `agent-guard` inspects your local git working tree and proves whether the contract was kept.

> **Hooks prevent. Agent Guard proves.**

Hooks and permission systems stop actions *before* they happen. Agent Guard does the complementary job: it produces an **AI Work Receipt** — a mechanical, after-the-fact check of what actually landed in git.

---

## Why this exists

When an AI agent edits your repo, "it said it only changed the auth module" is a claim, not a fact. Agent Guard turns the claim into a checkable receipt:

- **Hooks / permissions** are *preventive* — they block a command at the moment it runs.
- **Agent Guard** is *evidentiary* — it reads the resulting git diff and reports what was actually changed, staged, or left untracked, and whether any forbidden path was touched.

It is local-first by design:

- **No code upload.** Everything runs on your machine.
- **No API key.** There is no account and no network call.
- **Operates on your local git working tree** via ordinary git commands.

---

## Quick Start

Once published, install and run via `npx`:

```bash
npm install -D agent-guard
npx agent-guard init --preset generic
npx agent-guard prompt
npx agent-guard verify
npx agent-guard check
```

> **Early preview.** Not yet on npm — the package name and publish target are not final until release.
> Until then, use the local-development commands below (`npm run build` + `node dist/cli.js ...`).

Once installed, the package exposes two equivalent binaries: `agent-guard` and its short alias `ag`.

---

## Core workflow

1. **Create a contract** — `agent-guard init --preset generic` writes `.agent-guard/contract.yaml` (and an agent-facing `.agent-guard/README.md`).
2. **Brief the agent** — `agent-guard prompt` prints a paste-in instruction block listing the allowed/denied paths and rules.
3. **Let the agent work.**
4. **Verify state** — `agent-guard verify` checks the working tree (branch / scope / denied paths / staged / untracked / NUL). It does **not** run your tests.
5. **Run required checks** — `agent-guard check` runs the contract's `required_checks.commands` (tsc/tests/etc.).
6. Only when **both** pass, stage the allowed files yourself and commit.

`verify` and `check` are deliberately separate: `verify` inspects *state* (fast, no command execution); `check` runs *commands*. A passing `verify` is **not** "tests passed."

If you omit `--contract`, the contract is auto-discovered (see below).

---

## Commands

| Command | What it does | Needs git repo |
|---|---|---|
| `init --preset <generic\|nextjs-supabase>` | Create `.agent-guard/contract.yaml` + `.agent-guard/README.md`. Refuses to overwrite existing files. | no |
| `start` | Record a baseline of the current working tree to `.agent-guard/session.json` (see Baseline mode). Refuses if a denied path is already dirty, or if a session already exists. | yes |
| `verify [--json]` | State checks only (no commands run). Human report, or a stable one-line JSON with `--json`. | yes |
| `check` | Run `required_checks.commands`; all must match their `required_exit`. | no |
| `prompt` | Print a paste-in instruction block for the agent. | no |
| `report [--out <file>]` | Run `verify` and write a Markdown report. | yes |
| `pre` | Pre-start check (correct branch, nothing already staged). | yes |
| `help` | Usage. | no |

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

---

## Baseline mode (`start`)

Real repos are rarely clean — there are often pre-existing untracked files (docs, exports, scratch) unrelated to the current task. Without a baseline, `verify` flags all of them, drowning the real signal.

`agent-guard start` records the working tree at the start of a task into `.agent-guard/session.json` (a baseline). After that:

- **Ambient noise is removed.** Files that were already unstaged/staged/untracked at `start` are excluded from scope checks — `verify` reports only what changed *since* the baseline.
- **New violations are still caught.** A new out-of-scope or denied file created after `start` is flagged normally.
- **`denied_paths` is never hidden by a baseline.** Denied matching runs against the **full** current working tree, not the baseline-relative subset. You cannot bury a denied path by baselining it.
- **Only `.agent-guard/session.json` is ignored by `verify`** — the rest of `.agent-guard/` (e.g. `contract.yaml`) is treated normally.
- **Stale baselines are ignored, safely.** If you switch branches, or the recorded `baselineHead` is no longer an ancestor of `HEAD`, the baseline is dropped and `verify` falls back to full-tree checking (noisier, but it never hides changes).

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

## Presets

- **`generic`** — a starter patch-only contract: empty `allowed_paths` with protective `denied_paths` (`.env*`, key/cert files).
- **`nextjs-supabase`** — adds denied paths typical for a Next.js + Supabase app (migrations, lockfiles, `vercel.json`) and a `tsc --noEmit` check.

Both are starting points — edit the generated `.agent-guard/contract.yaml` for your project.

---

## What Agent Guard catches

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

## What Agent Guard does **not** do

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

## Local-first / privacy

- Runs entirely locally; no code or diff leaves your machine.
- No API key, no account, no telemetry, no network requests.
- Uses your installed `git` to read the working tree.

---

## Package status

Early preview (`0.2.0`). Not yet published to npm; the package name and publish target are **not final**. Until release:

```bash
npm run build           # emit dist/
node dist/cli.js verify --contract .agent-guard/contract.yaml
# or, without building:
npm run guard -- verify --contract .agent-guard/contract.yaml
```

---

## Contract schema

The authoritative schema — every field, default, and the YAML/JSON parsing rules — lives in [`CONTRACT.md`](CONTRACT.md). The source of truth is `src/schema.ts`; if this README and `CONTRACT.md` ever disagree, `CONTRACT.md` (and the code) win.
