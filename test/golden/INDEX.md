# agent-guard v0.1 golden baseline (A0.5)

- branch: v0.1-verify-check-split
- 캡처 케이스: 131개
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
| v04-01-claims-match | `guard claims --file claim.json --contract contract.yaml` | 0 |
| v04-02-claims-mismatch | `guard claims --file claim.json   (AI hid newfile.txt)` | 1 |
| v04-03-claims-no-file | `guard claims --file nope.json --contract contract.yaml   (missing)` | 2 |
| v04-04-explain-pass | `guard explain --contract contract.yaml` | 0 |
| v04-05-explain-fail | `guard explain --contract contract.yaml   (oos)` | 1 |
| v04-06-router-no-contract | `guard   (no command, no contract)` | 0 |
| v04-07-router-no-session | `guard   (no command; contract, no session)` | 0 |
| v04-08-router-verify | `guard start … ; guard   (no command → verify)` | 0 |
| v04-09-check-127 | `guard check --contract contract.yaml   (exit 127 = env problem)` | 1 |
| v05-01-init-promptia | `guard init --preset promptia` | 0 |
| v05-02-lint-promptia-missing | `guard lint --contract contract.yaml   (promptia, denied 누락)` | 0 |
| v05-03-lint-promptia-complete | `guard lint --contract contract.yaml   (promptia, denied 완비)` | 0 |
| v05-04-doctor-promptia | `guard doctor   (promptia preset 감지)` | 0 |
| v05-05-router-fail | `guard start … ; (new oos) ; guard   (no command → verify FAIL)` | 1 |
| v05-06-run-alias-no-contract | `guard run   (no contract → init 안내, run 별칭)` | 0 |
| v06-01-mode-no-contract | `guard mode   (no contract)` | 0 |
| v06-02-mode-active | `guard start … ; guard mode   (task mode active)` | 0 |
| v06-03-receipts-empty | `guard receipts   (none yet)` | 0 |
| v06-04-receipts-list | `guard receipts   (2 saved → 최신순 목록)` | 0 |
| v06-05-receipts-latest | `guard receipts --latest` | 0 |
| v06-06-receipts-cat | `guard receipts --cat   (최신 receipt 내용)` | 0 |
| v06-07-receipts-dir | `guard receipts --dir` | 0 |
| v07-01-presets | `guard presets` | 0 |
| v07-02-init-strict | `guard init --preset strict` | 0 |
| v07-03-init-relaxed | `guard init --preset relaxed` | 0 |
| v07-04-draft-scan | `guard draft-contract   (repo 스캔)` | 0 |
| v07-05-draft-preset-strict | `guard draft-contract --preset strict` | 0 |
| v07-06-review-strict | `guard review --contract contract.yaml` | 0 |
| v07-07-prompt-cursor | `guard prompt --cursor --contract contract.yaml` | 0 |
| v07-08-prompt-claude | `guard prompt --claude --contract contract.yaml` | 0 |
| v07-09-receipt-client-md | `guard receipt --format client-md --out client.md` | 0 |
| v07-10-audit | `guard audit   (1 receipt)` | 0 |
| v07-12-audit-json | `guard audit --json` | 0 |
| v07-11-audit-empty | `guard audit   (no receipts)` | 0 |
| v07-13-export-slack | `guard export --format slack --receipt receipt-A.json` | 0 |
| v07-14-export-json | `guard export --format json --receipt receipt-A.json` | 0 |
| v07-15-approve | `guard approve --receipt receipt-A.json --note '검수 완료'` | 0 |
| v07-16-approvals | `guard approvals` | 0 |
| v07-17-dashboard | `guard dashboard   (1 receipt → static HTML)` | 0 |
| v07-18-sign-no-key | `guard sign --receipt f.txt   (no keys init → exit 2)` | 2 |
| v07-19-verifysig-no-sidecar | `guard verify-signature --receipt f.txt   (no .sig.json → exit 2)` | 2 |
| v07-20-export-no-format | `guard export --receipt f.txt   (no --format → exit 2)` | 2 |
| v07-21-status-excludes-tooloutput | `guard status   (receipts/dashboard 제외 → untracked 2)` | 0 |
| s6-01-policy-init | `guard policy init --profile promptia` | 0 |
| s6-02-policy-show | `guard policy show` | 0 |
| s6-03-policy-check-forbid | `guard policy check   (.env touched → FAIL)` | 1 |
| s6-04-help-all | `guard help --all` | 0 |
| s6-05-verify-tripwire | `guard verify --contract contract.yaml   (policy tripwire)` | 1 |
| s6-06-verify-json-14keys-policy | `guard verify --json   (policy 있어도 14키)` | 1 |
| s6-07-explain-policy | `guard explain --contract contract.yaml   (policy)` | 1 |
| s6-08-begin | `guard begin   (policy+baseline+prompt)` | 0 |
| s6-09-done-ledger | `guard done --ledger` | 0 |
| s6-10-commit-check-pass | `guard commit-check   (PASS + trailer)` | 0 |
| s6-11-commit-check-fail | `guard commit-check   (.env → 차단)` | 1 |
| s6-12-trailer | `guard trailer` | 0 |
| s6-13-audit-pack | `guard audit-pack --out audit-packs/PK` | 0 |
| s6-14-replay | `guard replay --pack audit-packs/PK` | 0 |
| s6-15-attest | `guard attest --receipt receipt-A.json` | 0 |
| s6-16-ledger | `guard ledger rebuild ; guard ledger` | 0 |
| s6-17-incident | `guard incident` | 0 |
| s6-18-export-github-pr | `guard export --format github-pr --receipt receipt-A.json` | 0 |
| s6-19-export-otel | `guard export --format otel --receipt receipt-A.json` | 0 |
| s6-20-export-langfuse | `guard export --format langfuse --receipt receipt-A.json` | 0 |
| s6-21-report-audit | `guard report --type audit --out audit.md` | 0 |
| s6-22-receipt-redact | `guard receipt --redact --out r2.json` | 0 |
| v09-01-begin-kind-recon | `guard begin --kind recon` | 0 |
| v09-02-begin-kind-impl | `guard begin --kind implementation` | 0 |
| v09-03-begin-existing-baseline | `guard start … ; guard begin   (기존 baseline → 전환 경고)` | 0 |
| v09-04-begin-kind-bogus | `guard begin --kind bogus   (검증 실패)` | 2 |
| v09-05-start-kind | `guard start --kind recon --contract contract.yaml` | 0 |
| v09-06-status-kind | `guard start --kind implementation … ; guard status` | 0 |
| v09-07-receipt-kind | `guard start --kind implementation … ; guard receipt --out r.json` | 0 |
| v09-08-mode-kind | `guard start --kind recon … ; guard mode` | 0 |
| v09-09-close-recon-clean | `guard begin --kind recon ; (변경 0) ; guard close-recon` | 0 |
| v09-10-close-recon-dirty | `guard begin --kind recon ; (src/a.ts 변경) ; guard close-recon` | 1 |
| v09-11-close-recon-impl-refuse | `guard begin --kind implementation ; guard close-recon   (구현 세션 거부)` | 1 |
| v09-12-prepare-commit-pass | `guard start --kind implementation … ; guard prepare-commit` | 0 |
| v09-13-prepare-commit-block-oos | `guard … ; (outsider.txt) ; guard prepare-commit   (범위 밖 → 차단)` | 1 |
| v09-14-prepare-commit-linked | `guard … ; (src + tests/) ; guard prepare-commit --include-linked-tests` | 0 |
| v09-15-finish-pass | `guard … ; guard finish` | 0 |
| v09-16-finish-blocked | `guard … ; (.env.local) ; guard finish   (commit-check 차단)` | 1 |
| v09-17-commit-check-linked | `guard … ; (src + tests/) ; guard commit-check   (linked 가드 테스트 advisory)` | 1 |
| v09-18-lint-linked | `guard lint --contract contract.yaml   (linked_test_paths, expected 없음)` | 0 |
| v09-19-policy-show-mode | `guard policy show   (mode=measure_first)` | 0 |
| v09-20-commit-check-measure-first | `guard … ; guard commit-check   (mode=measure_first self-report)` | 0 |
| v09-21-claims-self-report | `guard claims --file claim.json   (modeClaims + externalActions self-report)` | 0 |
