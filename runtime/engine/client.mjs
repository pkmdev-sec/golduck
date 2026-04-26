/* ─────────────────────────────────────────────────────────────────────────
 * golduck messages client / provider dispatcher (runtime/engine/client.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Historically this file spoke only /v1/messages (Anthropic) and pointed at
 * the local cxr Bedrock proxy on 127.0.0.1:8741. It now also dispatches to
 * the OpenAI-compat + Gemini adapters so users with keys for GLM, Gemini,
 * GPT, DeepSeek, xAI/Grok, Mistral, Groq, OpenRouter, or a custom
 * OpenAI-compatible endpoint can swap model simply by setting GOLDUCK_MODEL
 * or using the /model slash command.
 *
 * Contract preserved for every existing caller:
 *   - buildRequestBody({...})   → Anthropic-shaped body (unchanged).
 *   - streamMessages(body, opts) → async-iterable of Anthropic-shaped
 *     SSE events (unchanged): message_start, content_block_start,
 *     content_block_delta{text|input_json}, content_block_stop,
 *     message_delta{usage}, message_stop.
 *
 * The adapters translate to/from each provider's native dialect so the
 * engine, TUI, verify pipeline, and tool renderers see the same shape
 * regardless of provider.
 * ───────────────────────────────────────────────────────────────────────── */
import { detectProvider, resolveAuthKey, resolveBaseUrl as resolveProviderBase } from '../providers/registry.mjs';
import { streamAnthropic } from '../providers/anthropic.mjs';
import { streamOpenAI, toOpenAIRequest } from '../providers/openai.mjs';
import { streamGemini, toGeminiRequest } from '../providers/gemini.mjs';

const PROXY_PORT = parseInt(process.env.CXR_PROXY_PORT || '8741', 10);
const DROIDX_PROXY_PORT = parseInt(process.env.DROIDX_PROXY_PORT || '8752', 10);

let _cachedBase = null;

function isPortAlive(port, host = '127.0.0.1', timeoutMs = 150) {
  return new Promise((resolve) => {
    import('node:net').then(({ createConnection }) => {
      const s = createConnection({ port, host });
      const finish = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
      s.setTimeout(timeoutMs);
      s.once('connect', () => finish(true));
      s.once('timeout', () => finish(false));
      s.once('error', () => finish(false));
    }).catch(() => resolve(false));
  });
}

/** Pre-warm the Anthropic base URL by probing the local cxr proxy first,
 *  falling back to the droidx proxy, then the direct API. */
export async function probeBaseUrl() {
  if (process.env.GOLDUCK_BASE_URL) return process.env.GOLDUCK_BASE_URL;
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  const candidates = [PROXY_PORT, DROIDX_PROXY_PORT];
  for (const p of candidates) {
    if (await isPortAlive(p)) {
      _cachedBase = `http://127.0.0.1:${p}/v1`;
      return _cachedBase;
    }
  }
  _cachedBase = `http://127.0.0.1:${PROXY_PORT}/v1`;
  return _cachedBase;
}

export function resolveBaseUrl() {
  if (process.env.GOLDUCK_BASE_URL) return process.env.GOLDUCK_BASE_URL;
  if (process.env.ANTHROPIC_BASE_URL) return process.env.ANTHROPIC_BASE_URL;
  if (_cachedBase) return _cachedBase;
  return `http://127.0.0.1:${PROXY_PORT}/v1`;
}

function effortFromBudget(budget) {
  if (!budget) return null;
  if (budget <= 8000) return 'low';
  if (budget <= 20000) return 'medium';
  if (budget <= 60000) return 'high';
  return 'xhigh';
}

/** Build an Anthropic-shaped request body. This body is what the rest of
 *  the engine authors; provider adapters translate if needed at send time. */
export function buildRequestBody({
  model, system, messages, tools = null, thinking = null,
  max_tokens = 16000, temperature = 1.0, stop_sequences = null, metadata = null,
}) {
  // Second-line-of-defense token ceiling. The router already caps at 128k,
  // but anything bypassing the router should also be bounded here.
  const _ceiling = parseInt(process.env.GOLDUCK_MAX_TOKENS_HARD || '128000', 10);
  if (Number.isFinite(_ceiling) && _ceiling > 0 && max_tokens > _ceiling) {
    max_tokens = _ceiling;
  }
  const body = {
    model,
    messages,
    max_tokens,
    stream: true,
    temperature,
  };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;
  if (thinking) {
    if (thinking.type === 'enabled' && thinking.budget_tokens) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: effortFromBudget(thinking.budget_tokens) };
    } else {
      body.thinking = thinking;
    }
  }
  if (stop_sequences) body.stop_sequences = stop_sequences;
  if (metadata) body.metadata = metadata;
  return body;
}

/** Provider dispatcher. Picks the adapter from the model slug and forwards
 *  the request. Returns an Anthropic-event async iterable regardless of
 *  provider so every upstream caller stays unchanged. */

/** Per-provider max-output-token caps. Router emits up to 128k (Opus cap),
 *  which other providers reject. We floor to each provider's real ceiling
 *  before the adapter serializes. Conservative defaults; override via env
 *  GOLDUCK_<PROVIDER>_MAX_TOKENS if needed. */
const PROVIDER_MAX_TOKENS = {
  anthropic: 128000,
  openai:     16384,
  glm:         8192,
  gemini:     65535,
  deepseek:    8192,
  xai:         8192,
  mistral:     8192,
  groq:        8000,
  openrouter:  8192,
  custom:      8192,
};

function capMaxTokens(body, provider) {
  const envKey = `GOLDUCK_${provider.name.toUpperCase()}_MAX_TOKENS`;
  const envVal = parseInt(process.env[envKey] || '', 10);
  const cap = Number.isFinite(envVal) && envVal > 0
    ? envVal
    : (PROVIDER_MAX_TOKENS[provider.name] || 8192);
  if (typeof body.max_tokens === 'number' && body.max_tokens > cap) {
    return { ...body, max_tokens: cap };
  }
  return body;
}

/** Strip Anthropic-specific headers that callers add (e.g. anthropic-beta
 *  for interleaved thinking). The dispatcher keeps them for the Anthropic
 *  adapter and drops them for every other provider so we don't leak
 *  vendor-specific headers across the wire. */
function filterHeaders(headers, adapter) {
  if (adapter === 'anthropic') return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.toLowerCase().startsWith('anthropic-')) continue;
    out[k] = v;
  }
  return out;
}

export function streamMessages(body, { headers = {}, signal = null } = {}) {
  const provider = detectProvider(body.model);
  const apiKey = resolveAuthKey(provider);

  // Anthropic path: prefer the local cxr proxy when reachable, otherwise
  // fall back to provider.baseUrl (cloud) with x-api-key.
  if (provider.adapter === 'anthropic') {
    const baseUrl = resolveBaseUrl();
    return streamAnthropic({ body, baseUrl, apiKey, extraHeaders: headers, signal });
  }

  // For every non-Anthropic provider we require an API key. If missing,
  // surface a clean async error so the TUI's error cell shows it instead
  // of a silent ECONNREFUSED.
  const baseUrl = resolveProviderBase(provider);
  if (!baseUrl) {
    return _errorIterable(new Error(`[${provider.name}] no base URL configured (set ${provider.name.toUpperCase()}_BASE_URL or GOLDUCK_CUSTOM_BASE_URL)`));
  }
  if (!apiKey) {
    return _errorIterable(new Error(`[${provider.name}] no API key found; set one of: ${provider.authEnvs.join(', ')}`));
  }

  if (provider.adapter === 'openai') {
    const capped = capMaxTokens(body, provider);
    const oaBody = toOpenAIRequest(capped);
    const extra = {};
    if (provider.name === 'openrouter') {
      extra['http-referer'] = process.env.OPENROUTER_REFERER || 'https://golduck.local';
      extra['x-title'] = 'golduck';
    }
    const safeHeaders = filterHeaders({ ...extra, ...headers }, 'openai');
    return streamOpenAI({ body: oaBody, baseUrl, apiKey, extraHeaders: safeHeaders, signal });
  }

  if (provider.adapter === 'gemini') {
    const capped = capMaxTokens(body, provider);
    const gmBody = toGeminiRequest(capped);
    return streamGemini({ body: gmBody, baseUrl, model: body.model, apiKey, signal });
  }

  return _errorIterable(new Error(`unknown provider adapter: ${provider.adapter}`));
}

function _errorIterable(err) {
  return {
    async next() { throw err; },
    [Symbol.asyncIterator]() { return this; },
    abort() {},
  };
}
