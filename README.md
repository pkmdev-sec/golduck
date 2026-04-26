# golduck

![CI](https://github.com/pkmdev-sec/golduck/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-green)
![Node: ≥20](https://img.shields.io/badge/node-%E2%89%A520-informational)

**A model-agnostic, richly-interactive terminal agent.** Bring your own API
key for Claude, GPT, Gemini, GLM, DeepSeek, Grok, Mistral, Groq,
OpenRouter, or any OpenAI-compatible endpoint — golduck picks the right
adapter from the model slug, streams the response, and keeps a full
conversation loop with tools, verification, memory, and a polished TUI.

> Not a wrapper over another agent. Native streaming client, tool
> registry, verify pipeline, and TUI written from scratch in \~15k LoC of
> Node + React/ink.

---

## Install — one line

```bash
curl -fsSL https://raw.githubusercontent.com/pkmdev-sec/golduck/main/scripts/remote-install.sh | bash
```

Then:

```bash
export OPENAI_API_KEY=sk-...        # or any other provider; see /providers
golduck                             # interactive TUI
```

Or clone and install manually:

```bash
git clone https://github.com/pkmdev-sec/golduck.git
cd golduck
./install.sh
```

### Providers & keys (pick any one — or several)

| Provider   | Example slug                   | Env var                              |
| ---------- | ------------------------------ | ------------------------------------ |
| Anthropic  | `claude-opus-4-7`              | `ANTHROPIC_API_KEY`                  |
| OpenAI     | `gpt-4o`, `o1-preview`         | `OPENAI_API_KEY`                     |
| Gemini     | `gemini-2.5-pro`               | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Zhipu GLM  | `glm-4-plus`                   | `ZHIPUAI_API_KEY` or `GLM_API_KEY`   |
| DeepSeek   | `deepseek-chat`                | `DEEPSEEK_API_KEY`                   |
| xAI / Grok | `grok-2`                       | `XAI_API_KEY` or `GROK_API_KEY`      |
| Mistral    | `mistral-large-latest`         | `MISTRAL_API_KEY`                    |
| Groq       | `llama-3.1-70b-versatile-groq` | `GROQ_API_KEY`                       |
| OpenRouter | `meta-llama/llama-3.1-405b`    | `OPENROUTER_API_KEY`                 |
| Custom     | whatever you export            | `GOLDUCK_CUSTOM_*` (see `.env.example`) |

Set `GOLDUCK_MODEL=<slug>` to pin a default, or switch mid-session with
`/model <slug>` inside the TUI.

Full list + per-provider env knobs: **[docs/providers.md](docs/providers.md)**.

---

## Quick look

```bash
golduck                             # interactive TUI (default)
golduck ask "refactor this fn"      # one-shot
golduck run -- "ship the PR"        # autonomous
golduck doctor                      # health / key coverage
```

Inside the TUI:

```
/providers           show which providers have API keys
/model gpt-4o        swap model for this session
/help                hotkeys + slash commands
```

---

## Architecture

```
golduck/
├── bin/                    CLI launchers (golduck, golduck-ask, etc.)
├── runtime/
│   ├── core/               orchestrate.mjs, ask.mjs, dag_runner.mjs
│   ├── engine/             engine.mjs (loop), client.mjs (SSE), registry,
│   │                       compact, tool_summarize, safety
│   ├── tools/              shell, fs, apply_patch, rlm, memory, web
│   ├── mcp/                stdio client for federated MCP servers
│   ├── ui/                 ANSI renderer (banner, streaming, usage)
│   ├── router/             complexity → thinking/verify/reflect
│   ├── context/            repo scan, AGENTS walk, bundle builder
│   ├── trace/              JSONL event sink + `golduck trace` renderer
│   ├── governance/         constitution + trust + budget gates
│   ├── verify/             panel-critic inline + CLI
│   ├── reflect/            post-run journal + lessons
│   ├── memory/             pins, journal, cost ledger
│   ├── hooks/              pre/post hooks (user scripts)
│   ├── skills/             user-defined recipes
│   ├── plan/               decomposition planner
│   └── daemon/             boot.mjs, doctor.py, selftest.mjs
├── completions/            zsh + bash
└── install.sh              one-shot installer
```

## Commands

| Command | What it does |
| --- | --- |
| `golduck` / `golduck run` | Autonomous run (interactive TTY or `-- prompt`) |
| `golduck ask "<q>"` | One-shot answer + panel verify, prints final text |
| `golduck plan "<goal>"` | Decomposition plan (JSON) |
| `golduck verify "<q>" "<a>"` | Panel-critic verdict on an answer |
| `golduck dag <name\|path>` | Run a JSON DAG file |
| `golduck skill list/run` | User skills catalog + invoker |
| `golduck memory list/get/set/search` | Pinned memory layer |
| `golduck hooks list/install/run` | User hook scripts |
| `golduck up` | Start cxr proxy + MCPs + daemon (idempotent) |
| `golduck down` | Stop all golduck-managed services |
| `golduck status` | Health report (JSON) |
| `golduck doctor` | Colour-coded env/deps self-check |
| `golduck self-test` | 5-stage live E2E smoke |
| `golduck trace` / `-f` | Render/tail the JSONL trace |
| `golduck daemon start\|stop` | Low-level daemon lifecycle |

## Run options

```
-m, --model <slug>        override model (default: Opus 4.7)
    --verify on|off|auto  default: auto (on for complex prompts)
    --reflect on|off|auto default: auto (deep for deep prompts)
    --persona <list>      e.g. reviewer,adversary,planner
    --budget <usd>        per-run cost ceiling (default 5)
    --max-turns <n>       safety cap on the tool loop (default 80)
    --fast                skip verify/reflect/compact for speed
    --trace               verbose tracer
    --dry-run             print route decision, don't execute
    --resume <sid>        resume a saved session
    --session <sid>       label this session for resume later
```

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md) for the full history of quality sweeps (waves 1–20) — verify/revise/rerun hardening, tool cache granularity, retry circuit breaker, safety budget, secret scanner, tool-output validator, unified-diff acceptance, async-aware test harness, expanded hard-blocks, and more.

## Install

```bash
./golduck/install.sh
```

The installer:

1. Verifies Node 20+ / python3 / git / ripgrep.
2. Ensures the cxr Bedrock proxy dependencies are installed.
3. Renders `~/.golduck/config/mcp.json` (user-editable) for MCP servers.
4. Symlinks `golduck` onto your `$PATH`.
5. Copies zsh + bash completions.
6. Runs `doctor` and optionally the live `self-test`.

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `GOLDUCK_HOME` | `~/.golduck` | State, logs, memory, traces |
| `GOLDUCK_MODEL` | `claude-opus-4-7` | Override model |
| `GOLDUCK_VERIFY` | `auto` | Panel-critic verify |
| `GOLDUCK_REFLECT` | `auto` | Post-run reflection |
| `GOLDUCK_BUDGET_USD` | `5` | Soft session ceiling |
| `GOLDUCK_MAX_TURNS` | `80` | Tool-loop safety cap |
| `GOLDUCK_COMPACT_SOFT` | `700000` | Tokens → start compacting |
| `GOLDUCK_COMPACT_HARD` | `900000` | Tokens → hard compact |
| `GOLDUCK_TRACE` | `0` | Force verbose tracer |
| `CXR_PROXY_PORT` | `8741` | Bedrock proxy port |
| `AWS_PROFILE`, `AWS_REGION` | — | For Bedrock auth (via cxr proxy) |
| `OPENAI_API_KEY` | — | Key for `gpt-*`, `o1-*`, `o3-*`, `o4-*` slugs |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Key for `gemini-*` slugs |
| `ZHIPUAI_API_KEY` / `GLM_API_KEY` | — | Key for `glm-*`, `chatglm-*` slugs |
| `DEEPSEEK_API_KEY` | — | Key for `deepseek-*` slugs |
| `XAI_API_KEY` / `GROK_API_KEY` | — | Key for `grok-*` slugs |
| `MISTRAL_API_KEY` | — | Key for `mistral-*`/`mixtral-*`/`codestral-*` slugs |
| `GROQ_API_KEY` | — | Key for `*-groq` slugs |
| `OPENROUTER_API_KEY` | — | Key for `org/model` slash slugs |
| `GOLDUCK_CUSTOM_{MODEL,BASE_URL,API_KEY}` | — | Custom OpenAI-compatible endpoint |

## Providers & API keys

golduck routes model calls based on the model slug. The default
`claude-opus-4-7` goes through the local cxr Bedrock proxy on
`127.0.0.1:8741` (no API key required). For every other provider you
need an API key — golduck picks the adapter from the slug, translates
request/response shape, and streams back Anthropic-shaped events so the
rest of the engine stays unchanged.

| Provider | Example slug(s) | API-key env(s) |
| --- | --- | --- |
| Anthropic (Claude) | `claude-opus-4-7`, `claude-haiku` | `ANTHROPIC_API_KEY` (or cxr proxy, default) |
| OpenAI | `gpt-4o`, `o1-preview`, `o4-mini` | `OPENAI_API_KEY` |
| Google Gemini | `gemini-2.5-pro`, `gemini-1.5-flash` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| Zhipu GLM | `glm-4-plus`, `chatglm-4` | `ZHIPUAI_API_KEY`, `GLM_API_KEY`, or `ZHIPU_API_KEY` |
| DeepSeek | `deepseek-chat`, `deepseek-coder` | `DEEPSEEK_API_KEY` |
| xAI (Grok) | `grok-2`, `grok-beta` | `XAI_API_KEY` or `GROK_API_KEY` |
| Mistral | `mistral-large-latest`, `mixtral-8x22b`, `codestral-latest` | `MISTRAL_API_KEY` |
| Groq | `llama-3.1-70b-versatile-groq` (`-groq` suffix) | `GROQ_API_KEY` |
| OpenRouter | anything with a `/` (e.g. `meta-llama/llama-3.1-405b-instruct`) | `OPENROUTER_API_KEY` |
| Custom (OpenAI-compatible) | whatever `GOLDUCK_CUSTOM_MODEL` is | `GOLDUCK_CUSTOM_API_KEY` + `GOLDUCK_CUSTOM_BASE_URL` |

### Switching models

```bash
# persistent, shell-level
export OPENAI_API_KEY=sk-...
export GOLDUCK_MODEL=gpt-4o
golduck

# or inside the TUI, per-session
/model gpt-4o
/providers      # show which providers have keys
```

Per-provider base overrides (for Azure/OpenAI-compatible gateways): set
`OPENAI_BASE_URL`, `MISTRAL_BASE_URL`, etc. A global override via
`GOLDUCK_BASE_URL` wins over everything — use it for mitmproxy / local
testing.

If you ask for a model whose provider has no key, the next turn emits a
clean error through the TUI's error cell rather than a silent timeout.

## MCP federation

`~/.golduck/config/mcp.json`:

```json
{
  "servers": {
    "obscura": { "command": "/path/to/obscura-mcp",
                 "args": [], "env": {} },
    "linear":  { "command": "linear-mcp", "args": [], "env": { "LINEAR_API_KEY": "..." } }
  }
}
```

All `tools/list` discovered from each server are namespaced
`<server>__<tool>` and dispatched via stdio JSON-RPC 2.0.

## Trace format

JSONL, one event per line. Examples:

```json
{"ts":"...","run_id":"...","kind":"event","name":"route.decision","model":"claude-opus-4-7","thinking":{...}}
{"ts":"...","run_id":"...","kind":"event","name":"engine.request","model":"...","tool_count":28,"thinking":true}
{"ts":"...","run_id":"...","kind":"event","name":"engine.response","stop_reason":"tool_use","usage":{...}}
{"ts":"...","run_id":"...","kind":"event","name":"tool.summarize_start","tool":"glob","bytes":1234567}
{"ts":"...","run_id":"...","kind":"event","name":"safety.verdict","tool":"shell","allow":false,"reason":"..."}
```

`golduck trace` renders these human-readably; `golduck trace --json` is
the passthrough.


## Interactive TUI

When stdin is a TTY, `golduck` (no subcommand) launches the full ink-based
TUI — header with model/tier/cwd/branch, streaming assistant cells with
markdown styling, parallel tool rows with per-tool spinners, thinking
summaries, cross-session recall banner, plan cards, verify verdicts,
handoff cards, compaction markers, inline toasts, bordered overlays, and
a persistent hotkey footer. Every engine event flows through a single
event store → React tree, so nothing the engine does is invisible.

```
 ● golduck  claude-opus-4-7  (opus)          ~/project › main
 ─────────────────────────────────────────────────────────────
 ▸ your prompt…

 ┌ ≈ recalled ───────────────────────────────────────────────┐
 │ 2 past lessons relevant to this prompt                    │
 │   [lesson 0.82]  Prefer store.push over renderer.line…    │
 └───────────────────────────────────────────────────────────┘

 ╭ ⎔ plan ───────────────────────────────────────────────────╮
 │ goal: wire the tui                                        │
 │ ✓ 1    extend store events                                │
 │ ⠋ 2    dispatch slash commands                            │
 │ ● 3    hook engine_tui to events                          │
 ╰───────────────────────────────────────────────────────────╯

 ◇ thought  (6L / 412c)  plan: extend the store with new…

 ▶ fs.read       {"path": "store.mjs"}
 ▶ apply_patch   {"patch": "*** Begin Patch…"}
   ✓ fs.read      4ms
   ✓ apply_patch  17ms  *** Update File: store.mjs

 ● assistant
   › Done
   Store now holds `busy`, `recall`, `tool_catalog`, and `plan`.
   - added CompactCell + PlanCell rendering
   - wired engine_tui.mjs to emit tool_catalog + recall
     in=2418  out=512  cache_hit=11207  $=0.0473  ctx=2.3%

 ■ verify: approve  conf=0.92

 ╭ handoff ──────────────────────────────────────────────────╮
 │ tools:  fs.read×1  apply_patch×1                          │
 │ files:  runtime/tui/store.mjs, runtime/tui/engine_tui.mjs │
 │ tests:  node tests/run_tests.mjs → 39 passed              │
 │ verify: approve  conf=0.92                                │
 │ spend:  $0.0473                                           │
 ╰───────────────────────────────────────────────────────────╯

 > Type a message, / for commands

 ●  golduck  ·  opus  ·  ctx 2.3%  ·  $0.0473  ·  28 tools   ⏎ send  / cmd  ^T trace  ^M memory  ^O tools  ^P plan  ^H help  ^C quit
```

### Hotkeys

| key   | opens                                                  |
|-------|--------------------------------------------------------|
| `⏎`   | send message (newline on multi-line)                   |
| `/`   | auto-opens slash-command palette; type to filter       |
| `@`   | mention picker — `@file`, `@tool:`, `@pin:`, `@skill:` |
| `⇥`   | autocomplete slash command (longest common prefix)     |
| `↑/↓` | cycle persistent prompt history in empty composer      |
| `^H`  | help (categorized hotkeys + commands)                  |
| `^T`  | trace (live-tail run JSONL)                            |
| `^M`  | memory (pins + lessons)                                |
| `^K`  | skills (installed prompt skills)                       |
| `^O`  | tools (native + MCP catalog)                           |
| `^S`  | stats (usage / cost / latency)                         |
| `^Q`  | sessions (resume prior)                                |
| `^R`  | reverse-history search                                 |
| `^P`  | plan viewer                                            |
| `^G`  | diff (last apply_patch)                                |
| `^B`  | bundle (live system prompt)                            |
| `^Y`  | MCP inspector (press `r` inside to force re-probe)     |
| `^F`  | reflect (lessons browser)                              |
| `^V`  | doctor (proxy + daemon + MCP health)                   |
| `^A`  | agents (spawn_agent / rlm activity)                    |
| `^X`  | metrics (p50/p95/p99 + think ratio)                    |
| `^W`  | workspace (git status + commits)                       |
| scroll | use your terminal's native scrollback (mouse wheel, Cmd+↑, Shift+PgUp) — long responses flow into the scrollback buffer automatically |
| `^L`  | clear conversation history                             |
| `^C`  | interrupt; twice to exit                               |
| `^D`  | hard exit                                              |
| esc   | close overlay / cancel in-flight                       |

### Slash commands (composer)

Type `/` and the palette auto-opens. Selection ⏎ runs the command. Type
to narrow. Commands that take arguments insert a stub like `/pin ` for
you to fill in before hitting enter.

**Query**: `/help`, `/commands`, `/recall <q>`, `/tokens`, `/cost`, `/verify`

**Overlays**: `/help`, `/memory`, `/skills`, `/tools`, `/trace`, `/stats`,
`/sessions`, `/plan`, `/diff`, `/bundle`, `/mcp`, `/reflect`, `/doctor`,
`/agents`, `/metrics`, `/persona`, `/bench`, `/rev`, `/spend`, `/dag`,
`/workspace`

**Session**: `/reset`, `/clear`, `/compact`, `/save`, `/export`,
`/resume <id>`, `/metrics-export`

**Edit & control**: `/pin <k>=<v>`, `/read <path>`, `/ask <q>`,
`/think <low|medium|high|xhigh>`, `/model <slug>`, `/undo`, `/theme <dark|light|classic>`

**Exit**: `/exit`, `/quit`

### Engine events → UI

Every engine feature has a visible TUI signal:

- **adaptive thinking** → `◇ thought  (NL / Nc)` preview row
- **parallel tools** → one `▶` row per tool with a spinner that flips to
  `✓ / ✗` with `name  duration  summary`; `apply_patch` renders the
  `Add/Update/Delete` ops inline
- **cross-session recall** → `≈ recalled` bordered banner
- **plan** → bordered `⎔ plan` box with step glyphs (pending/running/ok/
  blocked/skipped)
- **auto-verify / rerun-verify / rollback** → `■ verify: approve|revise|
  regressed` row with confidence + first three issues
- **compaction** → `⊝ compacted transcript (est_tokens=…)` marker
- **tool catalog** → `/tools` overlay + tool count in footer
- **spend + context** → live $ and ctx% in footer; usage footer on each
  assistant cell
- **handoff** → bordered card listing tools, files, tests, verdict, spend
- **errors** → red `✗` row at the point of failure
- **toasts** → transient bordered flash for slash-command feedback

Explicit launch: `golduck tui` (one-shot prompt: `golduck tui -p "…"`,
`--exit-after` for visual smoke). Non-TTY invocations still use the
line-streaming ANSI renderer (`runtime/core/orchestrate.mjs`).

## Self-test

```
▶ doctor                           ✓ doctor clean
▶ proxy /healthz                   ✓ proxy /healthz green
▶ native ask smoke (Opus 4.7)      ✓ ask smoke — answer="Pong"
▶ engine tool_use smoke            ✓ run + parallel tool_use smoke passed
▶ verify CLI smoke                 ✓ verify panel approved (confidence=0.99)
ALL CHECKS PASSED
```
