# golduck — CHANGELOG

## Unreleased — continuous quality sweep (waves 1–12)

### Quality loop (wave 1–2)
- **Fixed**: `rerunVerify` was unreachable (`engine.mjs` + `engine_tui.mjs`). The
  regression rollback path now runs on the turn AFTER a revise lands. Phase-A
  rerun happens before Phase-B revise so both paths stay live.
- **Added**: `GOLDUCK_MAX_AUTO_REVISIONS` (default 2). A confidently-wrong
  revised answer can be revised again before the ceiling ships with a warning.
- **Added**: `fact_extract` now also runs when auto-verify skips after a prior
  revise so the memory corpus grows on the full 'revise → approve' arc, not
  just the direct-approve case.
- **Added**: panel-verify no longer requires `!autoRevised`. Multi-persona
  critique runs regardless of revision state.
- **Tightened**: `shouldAutoVerify` now also fires on "claimy" absolute
  language (always / never / must) at 200+ chars and on structured multi-step
  answers at 400+ chars, not only on hedging / tool rounds.

### Runaway & cost controls (wave 1, 5, 7)
- **Added**: run-level safety budget (`spec.safetyBudget`, env
  `GOLDUCK_SAFETY_BUDGET_USD`, default $10). Trips without
  `GOLDUCK_ENFORCE_BUDGET=1`; event `engine.safety_budget_breach`.
- **Added**: retry-after + circuit breaker in `withRetry`. `Retry-After: N`
  hints (seconds or ms) override exponential backoff. After 6 failures in
  60s, the next call short-circuits with a clean error for 15s.
- **Added**: per-process RLM spend ledger + `GOLDUCK_RLM_BUDGET_USD`
  (default $5). `callSub` refuses before exceeding.
- **Added**: `rlm_map` concurrency gate (`GOLDUCK_MAP_CONCURRENCY`, default 4)
  so 20-context fanouts don't smash the proxy with 20 parallel requests.

### Tool cache (wave 1, 6)
- **Fixed**: engine now calls `invalidateByPrefix(path)` with the specific
  paths a mutating tool touched, not `invalidateAll()`. Reads to unrelated
  files survive an `apply_patch`.
- **Added**: `pathsForTool(toolName, input)` extracts touched paths from
  `apply_patch`, `write`, and (conservatively) `shell`.
- **Added**: `web_fetch`, `memory_get/list/search`, `skill_list`, and MCP
  tools with read-only suffixes (_read/_get/_list/_search/_fetch/_browse) are
  now cacheable.

### Tool robustness (wave 4)
- **Fixed**: `apply_patch` hunks now have a whitespace-insensitive Pass-2
  fallback. Benign indent drift no longer throws "context not found".
- **Added**: `fs.glob` and `fs.grep` fall back to `find` / plain `grep -rn`
  when ripgrep isn't installed (reports `engine: 'find-fallback'` /
  `'grep-fallback'`).
- **Added**: `shell` schema now accepts `stdin`, `background`, and `shell`
  (override). Background mode detaches and returns `{pid, log_path}`.
- **Added**: `snapshotBeforeWrite()` so `/undo` also reverts `write` tool
  calls. Engine/TUI wires it in before dispatch.

### Safety (wave 8, 10)
- **Added**: expanded hard-block patterns: `sudo rm -rf /`, `chmod -R 777 /`,
  `chmod 777 /{etc,var,usr,...}`, writing to `/proc/` or `/sys/`, reverse
  shell via `/dev/tcp/`.
- **Added**: secret scanning on outbound tool inputs. `findSecret()` catches
  AWS / Anthropic / GitHub / GitLab / Slack / PEM prefixes. Blocked at the
  safety layer with a specific reason.
- **Added**: safety-check verdict cache keyed on `(tool, sha1(input))` with
  a 5-minute TTL. Repeated identical calls pay one Opus veto, not N.
- **Fixed**: constitution parser now also collects `NEVER:` and `MUST:`
  directives. Bundle surfaces them as explicit sections.

### Persistence (wave 7)
- **Added**: daemon HTTP now requires `X-Golduck-Token`. Shared secret is
  written to `$GOLDUCK_HOME/state/daemon.token` at boot with 0600 perms.
  Constant-time compare; `GET /healthz` remains unauth'd.
- **Added**: `budget.mjs` sends the token on `/spend` POSTs.
- **Added**: opportunistic journal/session rotation. Jsonl files >1MB trim
  to `GOLDUCK_JOURNAL_MAX_LINES` (default 5000). Session files trim to
  `GOLDUCK_SESSION_KEEP` (default 50) newest.
- **Added**: `PINS_SCHEMA_VERSION` export in `tools/memory.mjs` for future
  migrations.

### Engine core dedup (wave 3)
- **Added**: `runtime/engine/core_helpers.mjs` — shared `usd`,
  `extractUserIntent`, `summarizeResult`, `errorHint`, `toolResultContent`,
  `maxAutoRevisions`, `safetyBudgetUsd`, `filesFromPatch`, `mirrorPriorAnswer`.
  Prevents drift between the CLI and TUI engine loops.
- **Added**: CLI↔TUI parity test — both engines must reference the same
  quality-loop anchors (`GOLDUCK_MAX_AUTO_REVISIONS`, `safety_budget_breach`,
  `autoRevisions`, `rerunVerify`, `scheduleFactExtract`).

### TUI (wave 9)
- **Added**: `runtime/tui/util/{trace_files, format_time, text}.mjs` to
  consolidate the 280 LoC of duplicated helpers across overlays.
- **Fixed**: `ReverseHistory` no longer renders `[-1]` for cross-session
  rows. Disk rows now show the date or `[~]`.
- **Added**: `Mcp` overlay accepts `r` to re-probe stale cached health.
- **Synced**: `POLISH.md` overlay count (24 user-facing + 2 infra files).

### Eval & ergonomics (wave 11, 12)
- **Added**: starter DAGs (`explain-and-summarize`, `repo-brief`) shipped in
  `dags/` and staged by `install.sh` into `$GOLDUCK_HOME/dags/` on first run.
- **Added**: three new starter skills (`explain-error`,
  `write-pr-description`, `draft-adr`) alongside the existing three.
- **Fixed**: `/resume` now rehydrates tool_result blocks as `tool_done`
  store events so visually-complete history returns, not just the chat.
- **Fixed**: README hotkey drift — `^Y` is MCP inspector only; press `r`
  inside to re-probe. The stale "yank focused cell" claim is retired.

### Regression coverage
All changes above are covered by additional unit tests in
`tests/run_tests.mjs` — +70 tests across waves 1–11. Total now: **353 passing**
(up from 186). The 5 pre-existing visual-contract snapshot drifts from the
droidx-parity refresh are untouched in this sweep and remain known-failing
(to be accepted in a separate visual-contract update).


## Waves 13–17 — secondary defects + integration test coverage

### Wave 13 — model override + unified diff + hardened safety + output validator
- **Added**: `runtime/engine/model_policy.mjs` — single source of truth for
  `resolveModel()`. Every sub-system caller (safety, tool-summarize, planner,
  panel-verify, skills, fact-extract) now routes through it, so
  `GOLDUCK_MODEL` / `/model <slug>` actually propagates to every Opus call.
- **Added**: unified-diff acceptance in `apply_patch`. Patches starting with
  `diff --git` or `--- a/` are auto-converted to Codex format for the
  Update-File common case.
- **Added**: `sudo`, `doas`, `pkexec` in shell now trigger the destructive
  veto path.
- **Added**: `scheduleFactExtract` gates on the per-process RLM budget
  (bails at 90 % of the cap).
- **Added**: `runtime/engine/output_validate.mjs` — `validateToolResult()`
  catches `null`, `undefined`, array, or scalar envelopes returned from an
  upstream tool / MCP server.
- **Added**: MCP server deaths emit `mcp.server_died` via a
  `globalThis.__golduckTrace` hook, so the Mcp overlay can surface them
  without an import cycle.

### Wave 14 — output validation wired into both engines
- **Added**: `validateToolResult` calls in both `engine.mjs` and
  `tui/engine_tui.mjs`, right after `registry.dispatch`, so malformed
  tool results are rewritten into a clean error envelope the model can
  re-emit against.
- **Added**: `openTrace` now publishes `globalThis.__golduckTrace.event`
  so modules outside the import graph (e.g. `mcp/client.mjs`) can emit
  trace events without a circular import.

### Wave 15 — TUI render cost + compact fidelity
- **Added**: `MarkdownCell` is now wrapped in `React.memo` with a
  shallow comparator on `entry` + `streaming` + `tick`. Prevents the
  500-cell transcript from re-rendering every streaming token.
- **Validated**: `compact.mjs` prompt still explicitly preserves file
  paths, tools-used summaries, user intents, open questions, and key
  decision facts. Asserted by a prompt-text test in the regression suite.

### Wave 16 — `turn.mjs` extraction + integration-style test
- **Added**: `runtime/engine/turn.mjs` exporting `streamOneTurn` and
  `dispatchToolCalls`. The second is observer-based so CLI and TUI
  callers can share the entire dispatch pipeline without renderer
  coupling. Full pipeline: schema → cache → safety (with cache + secrets)
  → on_tool hook → snapshot → git-warn → dispatch → output-validate →
  cache-invalidate → summarize → injection sniff → syntax check.
- **Added**: integration test runs `dispatchToolCalls` with a stub
  registry + observer and asserts all three failure modes land in a
  clean `{is_error: true}` envelope (missing required arg, broken
  registry result, schema-valid-but-unknown).
- **Added**: journal-rotation test writes a 12 000-line jsonl over 1 MB,
  invokes `recordSpend`, and asserts the tail is preserved while the
  head is trimmed.

### Wave 17 — doctor coverage + session rotation + env wiring
- **Added**: `doctor.py` now checks the daemon auth token (when daemon
  up), the `dags/` directory (and whether starter DAGs are staged), and
  surfaces `GOLDUCK_SAFETY_BUDGET_USD` / `GOLDUCK_MAX_AUTO_REVISIONS`
  / `GOLDUCK_RLM_BUDGET_USD` as informational lines.
- **Validated**: `GOLDUCK_SESSION_KEEP` actually bounds session-file
  count after a rotation pass (creates 60 files, caps at 10, verifies
  the newest survives).

### Cumulative regression coverage
Total test suite now: **377 passing** (up from 353 at end of wave 12).
Every behavioural change above is guarded by at least one dedicated
assertion in `tests/run_tests.mjs`.

## Waves 19–24 — final hardening

### Wave 19 — async test harness + visual-contract realignment
- **Fixed**: the test harness was silently greenlighting async test rejections.
  Now awaits async `fn()` via a `_pendingTests` drain before the summary.
  This exposed 3 real bugs that had been hiding (next two entries).
- **Fixed**: infinite recursion in `_snapshotFiles` introduced by wave 4's
  factoring; replaced with the real factored body.
- **Fixed**: MCP `stdin.write` EPIPE was crashing the process when the child
  died mid-write; added an `on('error')` handler on stdin that routes into
  `_onDeath` cleanly.
- **Realigned**: 5 pre-existing visual-contract assertions to match the
  droidx-parity UI (splash tagline, `> text` UserCell prefix, `? for help`
  status line hint, DROID ASCII block-art).
- **Added**: `GOLDUCK_COMPACT_THINK` env for the compaction thinking budget
  (0 disables).
- **Added**: `GOLDUCK_BON_TEMPERATURE_SPREAD` to vary best-of-N sampling.

### Wave 20 — panel think, nested validate, hardblocks, token cap
- **Added**: `GOLDUCK_PANEL_THINK` / `GOLDUCK_THINKING_BUDGET` threaded into
  panel verifier persona calls.
- **Added**: `validateToolInput` now walks nested object schemas and reports
  dotted error paths (e.g. `outer.inner`).
- **Added**: 8 more hard-block patterns (sudo rm, chmod 777 system dirs,
  /proc /sys writes, reverse shells via /dev/tcp, aws/ssh creds wipe, git
  filter-branch --all, history -c, crontab -r, umount -a, ufw disable,
  kernel sysctl writes).
- **Added**: `findSecret()` false-positive boundary tests.
- **Added**: `GOLDUCK_MAX_TOKENS_HARD` per-call ceiling (default 128000) as
  second line of defense beyond the router.
- **Added**: seventh starter skill (`find-bug`).
- **Fixed**: README now links `CHANGELOG.md`.

### Wave 21 — real mock-SSE integration test
- **Added**: in-process HTTP server that emits Anthropic-shaped SSE events
  (`message_start`, `content_block_{start,delta,stop}` for thinking + text
  + tool_use, `message_delta`, `message_stop`); `streamOneTurn` drives it
  end-to-end and every observer hook is asserted fired in the correct
  order (thinking summary before `assistant_start`, everything before
  `message_stop`).
- **Added**: `turn.mjs` observer-contract anchor so a future refactor
  that drops a hook gets caught immediately.

### Wave 22 — shared dispatch wired + guardrails
- **Added**: both engines route `runToolCalls` through
  `_sharedDispatchToolCalls`. Emergency rollback via `GOLDUCK_TURN_SHARED=off`.
- **Added**: `_safeStringify` in the tracer — circular refs become
  `[Circular]`, BigInt renders as `123n`, fallback event is emitted on
  unexpected failure so the event count stays honest.
- **Added**: daemon `/spend` clamps each POST to `[0, 100]` USD so a
  misbehaving caller can't zero out or balloon the ledger.
- **Added**: `GOLDUCK_MCP_TOOL_TIMEOUT_MS` for long-running MCP calls
  (obscura page loads etc).
- **Added**: `parseVerdict.suggested_fix` accepts string, array, or
  object; empty/null normalize to `null` consistently.
- **Added**: `golduck-help` bash header now documents every wave-20+
  env var.

### Wave 23 — legacy dispatch bodies deleted
- **Removed**: 216 lines of duplicated dispatch code across `engine.mjs`
  and `engine_tui.mjs`. Both now hold only thin adapter observers
  (renderer.line / store.push). `engine.mjs` 820 → 693 LoC;
  `engine_tui.mjs` 677 → 588 LoC.
- **Realigned**: wave-14 / wave-22 tests that asserted on the old inline
  text now assert on the turn.mjs-delegated shape.

### Wave 24 — unified-diff Add + Delete + retry integration
- **Added**: `unifiedToCodex` now handles `Add File` (`new file mode` or
  `--- /dev/null`) and `Delete File` (`deleted file mode` or
  `+++ /dev/null`). Multi-file patches mixing Update + Add + Delete in
  one blob work. Tested end-to-end.
- **Added**: retry backoff integration test — verifies exponential
  timing across attempts.
- **Added**: retry-after-hint integration test — error messages carrying
  `Retry-After: <n>ms` push the next attempt past the exp-backoff floor.
- **Added**: model-override propagation test — walks every sub-system
  caller (safety / tool_summarize / planner / panel_verify / skills /
  fact_extract) and fails the suite if any of them hardcode
  `model: 'claude-opus-4-7'` in a `buildRequestBody` call instead of
  going through `resolveModel()`.

### Cumulative state
**415 passing, 0 failing.** Started at 186 passed / 5 failed → now
415 passed / 0 failed (+229 new tests, all 5 original reds converted
to green in wave 19). All runtime `.mjs` files syntax-clean.

## Wave 25 — shared verify pipeline

### The extraction
- **Added**: `runtime/engine/verify_pipeline.mjs` — `runVerifyPipeline({state,
  systemBlocks, routed, spec, observer})` drives the full end-of-turn
  quality loop (Phase A rerun → Phase B auto-verify → Phase C panel-verify
  → Phase D best-of-N) as shared code that both engines call into.
- **Observer contract**: `onRerunImproved`, `onRerunRegressed`,
  `onReviseQueued`, `onReviseCeilingHit`, `onApproved`, `onPanelVerdict`,
  `onBestOfNReplaced`. CLI maps to `renderer.line`; TUI maps to
  `store.push`. No UI layer leaks into the pipeline.
- **Return contract**: `{ shouldContinue: bool }` — when a revise fires,
  the pipeline pushes the injection into `state.messages` and returns
  `shouldContinue: true` so the outer loop knows to re-enter the model
  turn.
- **Invariant tests**: verify_pipeline is observer-only (no
  renderer/store imports); both engines delegate to it; both have thin
  verify blocks (≤1 await between the pipeline call and the
  shouldContinue check).

### LoC reduction
- **`engine.mjs`: 693 → 588** (–105 LoC).
- **`engine_tui.mjs`: 588 → 526** (–62 LoC).
- Total outer-loop verify code now lives in one place (~180 LoC in
  `verify_pipeline.mjs`). A bug fix to revise-ceiling semantics, fact
  extraction, rerun rollback, panel consensus, or best-of-N swap lands in
  one file, not three.

### Cumulative state after 25 waves
**422 passing, 0 failing** (up from 415 at end of wave 24).
Engines are down to their true size; every quality-loop invariant is
guarded by the test suite; all runtime `.mjs` files syntax-clean.

## Wave 26 — helper dedup, embedding recall, registry + apply_patch coverage

### Dead helper removal
- **Removed** duplicated copies of `priceFor`, `usd`, `summarizeResult`,
  `errorHint`, `toolResultContent`, `extractUserIntent` from both
  `engine.mjs` and `engine_tui.mjs`. Both now import from
  `runtime/engine/core_helpers.mjs` — the single source of truth.
- Regression test asserts neither engine re-declares any of the six
  helpers and both have the expected import.
- **`engine.mjs`: 588 → 528** (–60 LoC total this wave). **`engine_tui.mjs`:
  526 → 466** (–60 LoC). Combined engine LoC now 994 — down 34 % from 1497
  at the start of the sweep.

### Optional embedding-backed recall
- **Added**: `runtime/memory/recall_embed.mjs` — `embedRecall({query, k, threshold})`
  + `indexEmbed({id, text, source})` with a **transparent fallback to
  lexical recall** when no embedder is configured, the index is empty,
  or the embedder throws.
- Embedder is pluggable: `globalThis.__golduckEmbed` or
  `process.env.GOLDUCK_EMBED_MODULE` loaded dynamically. No hard deps.
- Activated only when `GOLDUCK_RECALL_BACKEND=embed`. Default behavior
  (TF-IDF) is unchanged.
- Index format: one JSONL record per line at
  `$GOLDUCK_HOME/memory/embed-index.jsonl`, shape
  `{id, vec:[…], source, text, at}`. Append-only.
- 2 tests cover the fallback path and the live path (with a deterministic
  8-dim toy embedder wired via `globalThis.__golduckEmbed`).

### New coverage on load-bearing paths
- **`apply_patch dry_run`** — new test asserts the file is NOT touched
  when `dry_run: true` and that the returned `ops` array carries the
  planned operations. A second test checks a malformed/missing-file
  patch yields a clean `{ok: false}` envelope instead of a partial
  write.
- **`buildRegistry`** — two new tests. One asserts the registry
  exposes every required native tool name (`shell`, `read`, `write`,
  `ls`, `glob`, `grep`, `apply_patch`, `spawn_agent`, `memory_set`,
  `memory_get`, `web_fetch`, `skill_invoke`) and has the expected
  `dispatch` / `shutdown` shape. Another drives `dispatch('rea', …)`
  and verifies it produces an `unknown_tool` error with a `Did you
  mean` / `Known tools` suggestion.
- **`memory_get` on missing key** — test confirms the error envelope
  uses the documented `not_found: <key>` shape.

### Cumulative state after 26 waves
**430 passing, 0 failing** (up from 422 at end of wave 25).
Combined engines down from 1497 LoC at loop start to **994 LoC** today;
shared modules (`turn.mjs` + `verify_pipeline.mjs` + `core_helpers.mjs`
+ `model_policy.mjs` + `output_validate.mjs`) now carry the load-bearing
pipeline, keeping the CLI and TUI paths in lockstep by construction.

## Wave 27 — rolling-window compaction, enum validation, undo visibility

### Compaction rolling window
- `compact.mjs` now recognizes prior compaction markers via
  `_extractPriorSummary(messages)` and carries the earlier summary forward
  into the next round. Each round bumps a `gen=N` attribute on the
  `<golduck-compaction>` marker so `/trace` sees how many compactions ran.
- The summarization call now receives `[prior_summary, ...new_head]`
  instead of `head`, so accumulated decisions don't vanish across rounds.
- First-round behaviour is unchanged (generation 1, no prior to carry).
- 3 regression tests: prior-summary extraction on gen=2 markers, null on
  fresh transcripts, default gen=1 for legacy (unattributed) markers.

### Tunable thresholds
- **Recall floor**: `GOLDUCK_RECALL_THRESHOLD` env var (default 0.05) now
  controls the minimum cosine for a TF-IDF recall hit. Enables shops that
  want fewer-but-stronger hits or more-but-noisier hits without patching
  the source.

### Schema validation: enum support
- `validateToolInput` now enforces `enum` on leaf properties (strings,
  numbers, booleans). Violations report `enum_violation: <path> expected
  one of […], got <value>` with a hint listing the allowed values.
- Works at any depth — nested `outer.inner.mode` with an enum at the leaf
  is validated correctly.
- 2 regression tests cover string-enum happy/sad paths + nested enum.

### Undo visibility
- **New export `listUndoSlots({runId?})`** on `patch_snapshot.mjs`. Returns
  newest-first slots with `{runId, slot, dir, mtime, files: [{path, existed}]}`.
  Enables a future `/undo --list` overlay without running the reversion.
- 2 regression tests cover the happy path and the empty/unknown-run path.

### Miscellaneous
- **`runPreRequest` contract test**: the no-hook case must return the
  caller's messages unchanged (no-op surface guaranteed).
- **`fact_extract` empty-input guard**: confirms `scheduleFactExtract`
  with empty strings is a silent no-op (fire-and-forget semantics).

### Cumulative state after 27 waves
**440 passing, 0 failing.** No runtime regressions; rolling compaction is
the biggest behavioral improvement this wave (previously every compaction
threw away all prior-compaction decision trails).

## Wave 28 — inline scrollback + TUI chrome trim

- `runtime/tui/entry.mjs`: alt-screen is now opt-in (`GOLDUCK_ALTSCREEN=1`).
  Default behavior is inline rendering so the terminal's native scrollback
  works for every response. `GOLDUCK_NO_ALTSCREEN=1` is preserved as a
  back-compat alias.
- `runtime/tui/App.mjs`: viewport windowing gone. Every entry renders;
  `useHistoryFocus` + focus pointer + scroll badge removed. Long responses
  are no longer truncated.
- `runtime/tui/hooks/useKeybindings.mjs`: PgUp/PgDown, Shift+↑/↓, Ctrl+Y
  copy, and `e` expand are unbound. Ctrl+L clear-history survives. These
  keys conflict with terminal-native scrollback and were the root cause of
  "I can't scroll through the response".
- `runtime/tui/components/MarkdownCell.mjs`: fenced code blocks now use a
  dim left gutter instead of a rounded border, outer assistant-cell border
  stripped, redundant "streaming" header label removed (StreamingBar already
  signals it).
- 7 new regression tests covering the above.

## Wave 29 — ink <Static> for real scrollback persistence

- `runtime/tui/App.mjs`: splits `state.entries` into a **frozen** slice
  (everything that's already done) and a **live** tail (currently streaming
  assistant + any still-running tool). Frozen items render through Ink's
  `<Static>` so they're written to the terminal exactly once and committed
  to scrollback forever — no repainting, no tearing. This is the Ink-native
  answer to "I can't scroll the response": long replies that completed three
  turns ago stay fully visible in the scrollback buffer.
- New helper `computeLiveCut(state)` determines the split by walking entries
  in reverse and flagging any `tool` still `running` or the last
  `assistant` while `state.stream` is active. While a stream is in flight,
  the final entry is kept live for one more tick so a trailing `usage`
  update doesn't tear the committed cell.
- `runtime/tui/store.mjs`: dead `toggle_expand` case dropped (no longer
  dispatched after wave 28).
- `runtime/tui/hooks/useHistoryFocus.mjs`: orphaned hook + its test
  removed.
- 4 new regression tests.

## Wave 30 — TUI polish: status-line truth + docs + test coverage

- `runtime/tui/components/StatusLine.mjs`: dead `scrollBadge` prop fully
  removed from signature and crumbs list. Misleading ModeLine hint
  "ctrl+L for autonomy" corrected to the real bindings
  ("ctrl+H help · ctrl+L clear · esc cancel" / "ctrl+T trace · ctrl+M memory")
  since Ctrl+L is bound to clear-history.
- `runtime/tui/App.mjs`: `computeLiveCut` is now exported so the split
  logic can be unit-tested without booting ink/react.
- `README.md`: keybindings table scrubbed of stale PgUp/PgDn, ⇧↑/↓, and
  `e` (expand) rows. Replaced with a single row pointing at terminal-native
  scrollback.
- 5 new pure-logic tests for `computeLiveCut` covering empty state, all-frozen,
  streaming assistant, running tool, and mixed done-tool+streaming.


## Wave 31 — multi-provider support (GLM, Gemini, OpenAI, xAI, DeepSeek, Mistral, Groq, OpenRouter, custom)

Users with any of these API keys can now drive golduck through a model slug
pick, not just Claude via Bedrock. The existing Anthropic/cxr path is
unchanged — all non-claude slugs are additive.

- New `runtime/providers/registry.mjs` — slug → provider mapping with
  `detectProvider`, `resolveAuthKey`, `resolveBaseUrl`, `listProviders`.
- New `runtime/providers/anthropic.mjs` — extracted pass-through adapter
  (same `/v1/messages` wire format + cxr proxy path).
- New `runtime/providers/openai.mjs` — `/chat/completions` adapter with
  bidirectional translation (Anthropic shape ↔ OpenAI shape). Covers
  OpenAI, GLM (Zhipu), DeepSeek, xAI/Grok, Mistral, Groq, OpenRouter, and
  any custom OpenAI-compat endpoint.
- New `runtime/providers/gemini.mjs` — Google `streamGenerateContent`
  adapter with the same shape translation.
- `runtime/engine/client.mjs`: rewritten as a thin dispatcher. Every
  caller keeps the same `buildRequestBody` + `streamMessages` interface —
  dispatch happens by model slug. Anthropic-event contract preserved for
  the whole engine/TUI/verify pipeline.
- Slug rules: `claude-*` → anthropic · `gpt-*`/`o1-*`/`o3-*`/`o4-*` →
  openai · `glm-*`/`chatglm-*` → glm · `gemini-*` → gemini ·
  `deepseek-*` → deepseek · `grok-*` → xai · `mistral-*`/`mixtral-*`/
  `codestral-*` → mistral · `*-groq` suffix → groq · slug with `/` →
  openrouter · unknown → anthropic (fallback).
- Env knobs: `OPENAI_API_KEY`, `ZHIPUAI_API_KEY`/`GLM_API_KEY`,
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`,
  `XAI_API_KEY`/`GROK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`,
  `OPENROUTER_API_KEY`. Per-provider base overrides:
  `OPENAI_BASE_URL`, `GLM_BASE_URL`, etc. Custom local endpoints:
  `GOLDUCK_CUSTOM_BASE_URL`, `GOLDUCK_CUSTOM_API_KEY`,
  `GOLDUCK_CUSTOM_MODEL`.
- Missing-key errors surface cleanly through the TUI error cell
  (`[openai] no API key found; set one of: OPENAI_API_KEY`) rather than
  an opaque ECONNREFUSED.
- 25 regression tests across registry, OpenAI adapter, Gemini adapter,
  and dispatcher behavior.

## Wave 31b — /model polish + /providers + doctor integration

- `/model` now reports provider + key status on both query (`/model`) and
  set (`/model <slug>`). Warns loudly when a slug resolves to a provider
  without a configured key.
- New `/providers` slash command lists every provider with a ✓/· badge so
  users know what's ready before switching models.
- `runtime/daemon/doctor.py`: summary now includes a "providers with
  keys" line so `golduck doctor` surfaces the same info as `/providers`.
- 3 regression tests.

## Wave 31c — /providers rendering fix + banner tier refresh

Two residual bugs caught in post-audit:

- `/providers` was pushing a `{title, lines}` payload into the `notice`
  event, but `notice` expects `{message, kind}` and is consumed as a
  toast. Net effect: the list was invisible. Re-wired to the `recall`
  cell — the command now renders a titled, scrollable list with a ✓/·
  badge per provider.
- `/model <slug>` wrote only `{model: slug}` into the banner, leaving
  `banner.tier` stuck at the session-start value (`opus`). Header
  therefore still showed "opus" after switching to, say, `gemini-2.5-pro`.
  Now pushes `{model, tier: provider.name}` so the Header re-labels on
  provider switch.
- `store.mjs` `notice` case preserved — it's load-bearing for toasts
  emitted by `engine_tui.mjs` and `verify_bridge.mjs` (5 call sites).
- 3 regression tests locking both fixes in place.

## Wave 31d — per-provider max_tokens cap + anthropic-* header scrubbing

Two production-critical gaps that would have broken real calls on
non-Claude providers:

- The router emits up to 128k `max_tokens` (Opus cap). Other providers
  reject this: GLM caps at 8k, most OpenAI models 16k, Groq 8k, etc.
  Added `PROVIDER_MAX_TOKENS` map in `runtime/engine/client.mjs` with
  conservative defaults per provider. Each override is available via
  `GOLDUCK_<PROVIDER>_MAX_TOKENS` env (e.g. `GOLDUCK_GEMINI_MAX_TOKENS`).
- Six callers pass `{headers: {'anthropic-beta': 'interleaved-thinking-...'}}`
  through `streamMessages`. The dispatcher now runs `filterHeaders(h,
  adapter)` which strips any `anthropic-*` header when the target
  provider isn't Anthropic. Prevents vendor-specific headers from
  leaking into OpenAI/Gemini/GLM/etc. requests.
- 4 regression tests locking both fixes in place.

## Wave 31e — provider polish: full list render + initial tier + help category

Three more correctness issues found on a second audit pass:

- `RecallCell` sliced hits to 3. For `/providers` with 10 rows, that made
  7 providers invisible. Now the slice is bypassed whenever
  `entry.query` contains "provider"; memory-recall keeps the top-3
  teaser (the Memory overlay still shows the full list).
- Initial Header label was wrong. `entry.mjs` pushed `tier: routed.tier`
  which the router hardcodes to `opus` for backward-compat — so
  launching with `GOLDUCK_MODEL=gpt-4o` still showed "opus" in the top
  bar until the user ran `/model`. Now `spec.tier` is derived from
  `detectProvider(spec.model).name` at startup and the banner push
  prefers it.
- `/providers` wasn't listed in any Help overlay category. Added to the
  query section so `/help` actually surfaces it.
- 3 regression tests lock all three fixes.

## Wave 31f — reasoning-model body shape + retry hardening

Two more bugs that would surface the first time a user switched to
OpenAI's o1/o3/o4 family or mistyped an API key:

- OpenAI reasoning models (o1-*, o3-*, o4-*) reject `max_tokens` and
  reject non-default `temperature`. They require `max_completion_tokens`
  instead. `toOpenAIRequest` now detects the slug prefix and emits the
  right body shape; non-reasoning models (gpt-4o, gpt-4.1, etc.) keep
  the classic `max_tokens` + `temperature`.
- `retry.mjs`'s `shouldRetry` didn't exclude provider-config failures,
  so a missing/invalid API key or a mis-configured custom endpoint
  would burn all 4 retry attempts before surfacing the error. Added
  explicit non-retryable patterns for:
    - `[...] no API key found`
    - `[...] no base URL configured`
    - `unknown provider adapter`
    - `max_tokens ... too large` (provider-cap mismatch)
    - `invalid api key` / `api key is invalid` (some providers return
      this 200-ok inside a JSON body)
- 3 regression tests.
