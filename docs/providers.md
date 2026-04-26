# Providers — full reference

golduck routes every model call through a provider adapter selected by
the model slug. All adapters translate to and from the Anthropic
Messages SSE shape so the rest of the engine (tools, verify pipeline,
memory, RLM) is provider-agnostic.

## Slug → provider rules

| Pattern                                                      | Provider     | Adapter      |
| ------------------------------------------------------------ | ------------ | ------------ |
| `claude-*`, bare `claude`                                    | Anthropic    | `anthropic`  |
| `gpt-*`, `o1-*`, `o3-*`, `o4-*`                              | OpenAI       | `openai`     |
| `glm-*`, `chatglm-*`                                         | Zhipu GLM    | `openai`     |
| `gemini-*`                                                   | Google       | `gemini`     |
| `deepseek-*`                                                 | DeepSeek     | `openai`     |
| `grok-*`                                                     | xAI          | `openai`     |
| `mistral-*`, `mixtral-*`, `codestral-*`                      | Mistral      | `openai`     |
| `*-groq` suffix                                              | Groq         | `openai`     |
| contains `/` (e.g. `meta-llama/llama-3.1-405b`)              | OpenRouter   | `openai`     |
| matches `GOLDUCK_CUSTOM_MODEL`                               | Custom       | `openai`     |
| unknown                                                      | Anthropic    | fallback     |

First match wins. Custom models are detected first when
`GOLDUCK_CUSTOM_MODEL` matches the slug.

## Environment variables

### Per-provider API keys

```bash
ANTHROPIC_API_KEY=sk-ant-...              # Claude direct
OPENAI_API_KEY=sk-...                      # OpenAI (GPT + reasoning)
GEMINI_API_KEY=AIza...                     # Gemini (or GOOGLE_API_KEY)
ZHIPUAI_API_KEY=...                        # GLM (or GLM_API_KEY / ZHIPU_API_KEY)
DEEPSEEK_API_KEY=sk-...                    # DeepSeek
XAI_API_KEY=xai-...                        # Grok (or GROK_API_KEY)
MISTRAL_API_KEY=...                        # Mistral
GROQ_API_KEY=gsk_...                       # Groq
OPENROUTER_API_KEY=sk-or-...               # OpenRouter
```

### Per-provider base URL overrides (optional)

Useful for Azure / proxy / self-host:

```bash
OPENAI_BASE_URL=https://my-azure.example.com/v1
MISTRAL_BASE_URL=...
```

Or a global override that wins over everything:

```bash
GOLDUCK_BASE_URL=http://127.0.0.1:11434/v1
```

### Custom OpenAI-compatible endpoint

For self-hosted vLLM, Ollama, LM Studio, etc.:

```bash
GOLDUCK_CUSTOM_MODEL=llama3.1:70b
GOLDUCK_CUSTOM_BASE_URL=http://localhost:11434/v1
GOLDUCK_CUSTOM_API_KEY=ignored             # many local servers don't require one; this must be non-empty
```

### Per-provider max_tokens caps

golduck's router can emit up to 128k `max_tokens` (Claude Opus cap).
Other providers reject this. Defaults:

| Provider   | Cap       | Override env                          |
| ---------- | --------- | ------------------------------------- |
| Anthropic  | 128000    | `GOLDUCK_ANTHROPIC_MAX_TOKENS`        |
| Gemini     | 65535     | `GOLDUCK_GEMINI_MAX_TOKENS`           |
| OpenAI     | 16384     | `GOLDUCK_OPENAI_MAX_TOKENS`           |
| DeepSeek   | 8192      | `GOLDUCK_DEEPSEEK_MAX_TOKENS`         |
| xAI        | 8192      | `GOLDUCK_XAI_MAX_TOKENS`              |
| Mistral    | 8192      | `GOLDUCK_MISTRAL_MAX_TOKENS`          |
| GLM        | 8192      | `GOLDUCK_GLM_MAX_TOKENS`              |
| Groq       | 8000      | `GOLDUCK_GROQ_MAX_TOKENS`             |
| OpenRouter | 8192      | `GOLDUCK_OPENROUTER_MAX_TOKENS`       |
| Custom     | 8192      | `GOLDUCK_CUSTOM_MAX_TOKENS`           |

## Inside the TUI

```
/providers           list providers with ✓ (key configured) / · (not)
/model               show current model + provider + key status
/model <slug>        switch; warns loudly if the target has no key
```

`golduck doctor` shows the same key coverage on the command line.

## Gotchas

- **OpenAI reasoning models** (`o1-*`, `o3-*`, `o4-*`) use
  `max_completion_tokens` and reject `temperature` — handled
  automatically.
- **OpenRouter** requires a `HTTP-Referer` header; we set it to
  `https://golduck.local` by default. Override via
  `OPENROUTER_REFERER=...` if your account is gated.
- **Anthropic** goes direct (`api.anthropic.com`) when
  `ANTHROPIC_API_KEY` is set, or through a local Bedrock/cxr proxy at
  `127.0.0.1:8741` if present. First-live wins.
- **Streaming contract**: every adapter yields
  `message_start` → `content_block_start`/`content_block_delta`/`content_block_stop`
  → `message_delta` (with usage) → `message_stop`. Tool calls come
  through as `tool_use` content blocks with `input_json_delta` deltas.
  This is the Anthropic shape; see `runtime/engine/client.mjs` for the
  dispatcher and `runtime/providers/*.mjs` for each adapter.
