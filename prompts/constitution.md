# golduck — project constitution (example)

This file is optional. When present at `$GOLDUCK_HOME/constitution.md` OR
`<repo>/.golduck/constitution.md`, its contents are injected into every
system bundle. Prefix-style directives (FORBID:, MUST:, NEVER:) can be
parsed by the governance gates.

## Strict rules

FORBID: /etc/
FORBID: secrets/
FORBID: .env

NEVER: force-push to main
NEVER: commit API keys
MUST: run tests before committing
MUST: write tests for new public APIs
MUST: update docs when changing public APIs

## Project style (example — customize)

- Code style: Rust 2024, clippy-clean, rustfmt on save.
- Tests: use `cargo nextest run`, prefer deep-equality over field-by-field.
- Commits: conventional-commits style (feat:, fix:, docs:, chore:).
- PRs: always describe the change + testing approach.
