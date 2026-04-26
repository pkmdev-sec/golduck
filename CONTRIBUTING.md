# Contributing to golduck

Thanks for your interest! This doc tells you how to set up, what the ground rules are, and how to land a change.

## Setup

```bash
git clone https://github.com/pkmdev-sec/golduck.git
cd golduck
./install.sh
```

Run the tests:

```bash
node tests/run_tests.mjs
```

All 305+ tests must stay green. CI runs the same command on every PR.

## Ground rules

1. **No file over ~500 LoC**. If a module grows past that, split it. The large central files (`App.mjs`, `engine.mjs`, `engine_tui.mjs`) have a strict budget — check `wc -l` before opening a PR that grows them.
2. **Every behavior change gets a regression test.** The test runner lives in `tests/run_tests.mjs` — keep new tests in the existing wave-style blocks.
3. **Provider changes keep the Anthropic-shaped event contract.** If you add a new provider adapter in `runtime/providers/`, it must yield `message_start` → `content_block_*` → `message_delta`/`message_stop` events so the rest of the engine stays unchanged.
4. **Slash commands must show up in `/help`** (categorised in `runtime/tui/overlays/Help.mjs`).
5. **Security**: never commit API keys, tokens, or host-specific paths. `.gitignore` covers the obvious ones; audit anything that touches `process.env`.

## Dev loop

```bash
# Edit files...
node tests/run_tests.mjs                # run unit tests
golduck                                 # spins up the TUI against your key
```

The `golduck` command is installed as a symlink to `bin/golduck`, so edits are live without a rebuild.

## Submitting a PR

- One focused change per PR.
- Describe the bug/feature in the first line of the commit message (imperative, ≤72 chars).
- Include before/after screenshots for any TUI change.
- Link to the issue if one exists.

By contributing you agree that your contributions are licensed under the MIT License of this project.
