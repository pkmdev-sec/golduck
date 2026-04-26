# golduck TUI — visual polish inventory

Last updated after 30 polish waves. Every surface in the TUI has been
through at least one targeted pass.

## Layout

- **Alt-screen buffer** — takes over the terminal on launch (`\x1b[?1049h`),
  restores on any exit path (signal, uncaught, normal). Opt out with
  `GOLDUCK_NO_ALTSCREEN=1`.
- **Header** — single-line brand + model + tier badge on left, cwd + git
  branch on right, divider below.
- **History body** — flex column of cells, last 200 entries.
- **Optional overlay pane** — rendered inline below history when open, with
  a dim separator above it.
- **Optional toast** — slide-in (180ms) bordered flash for slash-cmd
  feedback.
- **Composer** — rounded-bordered pill with color shift by mode.
- **Status line** — spinner · brand · tier · ctx% · $ · tools · uptime · msgs
  + inverse-chip hotkey legend, auto-trimming.

## Cells

Every cell kind uses a consistent pattern: either a **left-bar
semantic gutter** (user, assistant, verify) or a **rounded `BorderedCard`
with title + badge** (recall, handoff, plan, error).

| Cell       | Style                                                    |
|------------|----------------------------------------------------------|
| user       | cyan `│` left-bar + `you` header                         |
| assistant  | magenta `│` left-bar, `● assistant · streaming`,          |
|            | pulse glyph, markdown, cursor block, usage footer         |
| thinking   | italic `◇ thought  NL · Nc  preview…`                    |
| tool       | `▶ name  arg` + `✓/✗ dur size_badge summary` + op-pills  |
| toolchain  | `╭─ N tools (parallel) ├▶ ... └▶` tree                    |
| verify     | semantic-colored `│` left-bar + `✓/↻/✗ verify label %`   |
| recall     | rounded card, `◇ recalled · N matches` + inverse kind    |
| plan       | rounded card, `⎔ plan · done/total` + status-glyph rows  |
| compact    | dim `⊝ compacted transcript (≈N tokens)`                  |
| retry      | dim `↻ retry #N (wait Xms) — reason`                     |
| handoff    | rounded card, `✓ handoff · verdict · conf`                |
| error      | red-bordered card + dismiss hint                         |

## Typography

- `◇` for overlay titles (consistent across all 24)
- `·` as separator across titles, footer, usage stats
- `▸ you` / `● assistant` for cell headers
- Usage footer: `↑ Nk · ↓ N · cache Nk · $0.0000 · ctx N%`
- Locale thousands in token counts, 2-decimal scores, 4-decimal dollars
- Relative times (`3m ago`, `2h ago`, `1d ago`) in lists

## Interactions

- Blinking cursor (500ms toggle)
- Ghost-text slash completion
- Multi-line composer with `…` continuation prefix
- ↑/↓ persistent cross-session prompt history (jsonl at `~/.golduck/state/history.jsonl`)
- `⇥` tab to autocomplete (LCP)
- `@` mention picker (file/tool/pin/skill)
- Mode chip in composer (`▸ slash`/`▸ mention`/`▸ prompt`)
- Char counter after 30 chars
- Border color by mode (magenta slash, cyan mention)
- Live streaming bar with flowing sine wave
- Shimmer loader on running tools
- Full-height magenta left-border when a cell is focused
- Scroll position chip (`⇕ 5/47`) in status line
- Toast slide-in
- Session uptime hidden for first 5s

## Overlays (24)

All follow the same pattern: bordered round, `◇ name · subtitle` title,
optional right-badge, `esc to close · refresh=Ns` footer. Use fixed-width
Box columns, not padEnd strings.

help, commands, memory, skills, tools, trace, stats, sessions, plan, diff,
bundle, mcp, reflect, doctor, agents, metrics, persona, bench, rev, spend,
dag, workspace, + the floating file-mention picker.

## Themes

- `GOLDUCK_THEME=dark` (default)
- `GOLDUCK_THEME=light` — blue accent for light terminals
- `GOLDUCK_THEME=classic` — monochrome-safe
- `/theme <name>` at runtime (re-launch to fully apply)

## What's been tested

- 68 unit tests cover store, commands, recall, file scanner, patch_snapshot,
  metrics_export, resume_detect, verify_bridge, dag_reader, history_store,
  lessons
- Visual smoke at 80/100/120/140/180 col widths
- Every cell kind individually
- Realistic multi-tool + streaming sessions
- Edge cases: empty handoff, 0-est compact, long error messages, long user
  prompts with wrap, ghost without match

## Files

Total: **69 TUI modules, ~8,200 LoC** under `runtime/tui/`.

## Wave 42 — engine layer autonomous quality push (2026-04-25)
Shifted focus from TUI polish (now at deep steady-state) to the engine layer
where Opus 4.7 reasoning is actually shaped. Six new modules, five wiring
patches across both CLI + TUI engine paths, 48 new contract assertions.

### New modules
- `runtime/governance/patterns.mjs` (106 LoC) — single source of truth for
  hard-block + injection regex. Replaces three drifting duplicates.
- `runtime/engine/best_of_n.mjs` (164 LoC) — terminal-turn parallel sampling
  + rlm_verify panel scoring, swaps in winner over original. Fires only when
  `routed.reflect==='deep'` AND tool rounds happened AND answer ≥400 chars.
- `runtime/engine/planner.mjs` (140 LoC) — pre-turn structured planner:
  { goal, subgoals[], risks[], checks[], decompose, first_action }.
  Prepended as cache-friendly per-turn system block. Fires on hard tasks.
- `runtime/memory/fact_extract.mjs` (123 LoC) — auto-distills 0-3 durable
  facts from approved turns into `facts.jsonl` (previously had NO writer).
- `runtime/memory/refresh.mjs` (96 LoC) — mid-run memory refresh: tiny
  per-turn system block with top-3 recall hits + new facts/lessons since
  last refresh. Solves "bundle frozen at turn 0" staleness.

### Wiring (applied to both engine.mjs + engine_tui.mjs for parity)
- `validateToolInput` now actually fires before tool dispatch (was a dead import).
- `panelVerify` now actually runs when `routed.persona.length ≥ 2` (was orphan).
- `routed.persona` honored via new `resolveRoster(routed)` in panel_verify.
- `routed.fanout_cap` plumbed via `GOLDUCK_FANOUT_CAP` env into `rlm.mjs`.
- Panel is now parallel (was serial-by-design), cuts panel latency ~3x.
- `maybeAutoLesson` now fires on CLI engine too (was TUI-only).
- `scheduleFactExtract` fires on every approve verdict, fire-and-forget.
- Planner + memory refresh both prepend ephemeral blocks without disturbing
  the main cached bundle.

### New tool
- `memory_fact_append` — lets the model persist durable facts itself.

### Reliability fixes
- MCP stdio clients now auto-reconnect on proc death with 3-per-60s cap.
- `_onDeath` rejects pending requests instead of silently hanging.
- `_send_raw` bypasses reconnect loop during handshake itself.

### Test growth
- 99 → 147 visual_contract assertions (+48)
- 68 → 69 unit tests (budget-gate fixtures)
- All green.

## Wave 43 — engine layer II, self-critiquing systems (2026-04-26)
Added four new modules + two extensions, migrated five duplicate JSON-parse
call-sites, wired everything through both engine paths.

### New modules
- `runtime/engine/personas_library.mjs` — built-in verifier personas
  (reviewer, adversary, planner, correctness, security, performance, style,
  test-coverage, clarity, completeness + `$GOLDUCK_HOME/personas/<name>.md`
  overrides). `defaultTrio()` replaces the old single-`correctness` fallback.
- `runtime/engine/tool_cache.mjs` — LRU+TTL cache for idempotent tool reads
  (`read`, `ls`, `glob`, `grep`). 30s TTL, 128-entry cap, auto-invalidate
  on apply_patch/write/mutating shell.
- `runtime/engine/json_parse.mjs` — shared `safeJsonParse` /
  `extractJsonBlock` / `parseVerdict` replacing five duplicated
  `JSON.parse(text.replace(...fences...))` sites.

### Extensions
- `runtime/engine/planner.mjs` — new `critiquePlan()` + `buildPlanWithCritique()`
  for plan → critic → revise loop on hard tasks (thinkingBudget ≥ 6000).
  Catches subgoals that miss the user's ask.
- `runtime/engine/best_of_n.mjs` — new `adaptiveSamples(priorVerdict)`:
  0 samples when auto-verify approved with conf ≥ 0.85, 1 when ≥ 0.65,
  2 otherwise. Saves budget on easy turns, spends it on hard ones.

### Wiring (both `engine.mjs` + `engine_tui.mjs`)
- Tool cache: 5 insertions per file (cacheKey → getCached → cache-hit fast
  path → setCached on success → invalidateAll on mutation).
- `buildPlan` → `buildPlanWithCritique`. Surfaces `[plan: N subgoals · critiqued]`.
- Fixed hard-coded `samples: 2` → `adaptiveSamples(state.lastVerify, 2)`.

### Migration
- `safety.mjs`, `panel_verify.mjs`, `rlm.mjs`, `fact_extract.mjs`, `planner.mjs`
  all now call `safeJsonParse` / `parseVerdict` from `json_parse.mjs`.
  Only remaining `JSON.parse` in model-output paths: 0. (Config-file parses
  in panel_verify legitimately remain.)

### Test growth
- 147 → 178 contract assertions (+31)
- 69 → 92 unit tests (+23, mostly json_parse regression)
- All green.

## Wave 44 — eval harness, regression detection (2026-04-26)
Built the missing piece: a way to *prove* wave-over-wave quality. Without this,
every engine change (planner, best-of-N, panel-verify, persona library) was a
guess; now we can measure.

### New module + CLI
- `runtime/eval/golden.mjs` — 12 curated prompts across 3 tiers (easy/medium/hard),
  stable IDs, each with a human-readable `expect` rubric.
- `runtime/eval/runner.mjs` — runs every prompt through Opus 4.7 (tools-disabled
  for determinism, tier-scaled thinking budget), then scores each answer with
  `rlm_verify` against the rubric. Confidence-weighted scoring:
  `score = rubric * (0.5 + 0.5 * confidence)`.
- `runtime/eval/cli.mjs` — `golduck eval [--tier ...] [--diff] [--list] [--wave]`.
  Auto-diffs against the previous report when 2+ exist. Persists to
  `$GOLDUCK_HOME/eval/{runs/<ts>.json, latest.json}`.
- `bin/golduck-eval` + routing in `bin/golduck`.

### Usage
```
golduck eval --wave wave-43         # full run (~$1.50, ~5 min)
golduck eval --tier easy            # quick sanity (~$0.10)
golduck eval --diff                 # compare last two reports
```

### Tier thinking budgets
- easy: 8k tokens  (factual recall, simple code)
- medium: 16k (decomposition, idiom recall)
- hard: 32k (architecture, multi-step reasoning, root-cause analysis)

### Regression detection threshold
0.05 score delta. Prompts within ±0.05 between runs = "noise"; anything
outside = surfaced in the diff as improved/regressed.

### Test growth
- 178 → 191 contract (+13, covers golden set shape + diff math)
- 92 unit stable
- All green.


# Wave 9 overlay inventory (corrected)

Authoritative count: **24 user-facing overlays** plus 2 infrastructure files (`OverlayFrame`, `SelectList`).

User-facing: Agents, Bench, Bundle, Commands, Dag, Diff, Doctor, FileMention, Help, Mcp, Memory, MentionPicker, Metrics, Persona, Plan, Reflect, ReverseHistory, Sessions, Skills, Spend, Stats, Tools, Trace, Workspace.

`FileMention` is the floating @-file picker; `MentionPicker` is the multi-kind (@file/@tool:/@pin:/@skill:) picker that superseded it. Both coexist for now but `MentionPicker` is preferred.

`Toast`'s slide-in animation has been intentionally removed (caused flicker in embedded terminals). The component now renders a static single-row flash.
