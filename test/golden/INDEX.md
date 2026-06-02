# agent-guard v0.1 golden baseline (A0.5)

- branch: v0.1-verify-check-split
- 캡처 케이스: 45개
- 결정론: 고정 git identity(ci/ci@local) + 고정 DATE(2025-01-01T00:00:00 +0000) → headHash 재현
- 정규화(스냅샷 한정): $HOME→<HOME>, /tmp/claude-1000/ag-gold-*→<FIXTURE>

| case | command | exit |
|---|---|---|
| case-01-verify-pass | `guard verify --contract contract.yaml` | 0 |
| case-02-verify-denied-fail | `guard verify --contract contract.yaml` | 1 |
| case-03-verify-untracked-fail | `guard verify --contract contract.yaml` | 1 |
| case-04a-verify-json-pass | `guard verify --json --contract contract.yaml` | 0 |
| case-04b-verify-json-denied-fail | `guard verify --json --contract contract.yaml` | 1 |
| case-05-check-pass | `guard check --contract contract.yaml` | 0 |
| case-06-check-fail | `guard check --contract contract.yaml` | 1 |
| case-07-prompt | `guard prompt --contract contract.yaml` | 0 |
| case-08-report | `guard report --contract contract.yaml --out report.generated.md` | 0 |
| case-09a-pre-pass | `guard pre --contract contract.yaml` | 0 |
| case-09b-pre-fail | `guard pre --contract contract.yaml` | 1 |
| new-01-discover-agdir-yaml | `guard verify   (auto-discover .agent-guard/contract.yaml)` | 0 |
| new-02-discover-agdir-json | `guard verify   (auto-discover .agent-guard/contract.json)` | 0 |
| new-03-discover-priority | `guard verify   (priority: .agent-guard/contract.yaml > .json > agent-guard.yaml > agent-guard.json)` | 0 |
| new-04-init-generic | `guard init --preset generic` | 0 |
| new-05-init-nextjs-supabase | `guard init --preset nextjs-supabase` | 0 |
| new-06-init-overwrite-fail | `guard init --preset generic   (재실행: 덮어쓰기 거부)` | 1 |
| new-07-init-unknown-preset | `guard init --preset bogus` | 2 |
| new-08-init-no-preset | `guard init` | 2 |
| p2-01-utf8-paths-json | `guard verify --json --contract contract.yaml` | 0 |
| p2-01b-utf8-paths-human | `guard verify --contract contract.yaml` | 0 |
| p2-02-denied-utf8-json | `guard verify --json --contract contract.yaml` | 1 |
| p1a-01-start-success | `guard start --contract contract.yaml` | 0 |
| p1a-02-start-denied-fail | `guard start --contract contract.yaml` | 1 |
| p1a-03-start-exists-fail | `guard start --contract contract.yaml   (재실행: 덮어쓰기 거부)` | 1 |
| p1a-04-start-no-contract | `guard start   (no --contract, none discoverable)` | 2 |
| p1b-01-no-session-ambient-fail | `guard verify --json --contract contract.yaml   (no start)` | 1 |
| p1b-02-session-ambient-pass | `guard start … ; guard verify --json --contract contract.yaml` | 0 |
| p1b-03-session-new-oos-fail | `guard start … ; (new file) ; guard verify --json` | 1 |
| p1b-04-session-new-denied-fail | `guard start … ; (new .env.local) ; guard verify --json` | 1 |
| p1b-05-session-json-excluded | `guard start … ; guard verify --json   (session.json 제외)` | 0 |
| p1b-06-stale-branch-degrade | `guard start (main) … checkout other ; guard verify --json` | 1 |
| p1b-07-session-json-14keys | `guard start … ; guard verify --json   (14키 유지)` | 0 |
| p1b-08-stale-human-degrade | `guard start (main) … checkout other ; guard verify --contract contract.yaml` | 1 |
| v03-01-status-no-session | `guard status --contract contract.yaml` | 0 |
| v03-02-status-with-session | `guard start … ; guard status --contract contract.yaml` | 0 |
| v03-03-status-stale | `guard start (main) … checkout other ; guard status` | 0 |
| v03-04-reset-with-session | `guard start … ; guard reset` | 0 |
| v03-05-reset-no-session | `guard reset   (no session)` | 0 |
| v1-01-receipt-json | `guard start … ; guard receipt --format json --out receipt.json` | 0 |
| v1-02-receipt-md | `guard start … ; guard receipt --format md --out receipt.md` | 0 |
| v1-03-receipt-fail | `guard receipt --format json --out receipt.json   (no start, oos)` | 1 |
| v1-04-doctor-ok | `guard doctor` | 0 |
| v1-05-doctor-no-contract | `guard doctor   (no contract)` | 0 |
| v1-06-lint-warn | `guard lint --contract contract.yaml` | 0 |
