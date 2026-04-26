/* ─────────────────────────────────────────────────────────────────────────
 * golduck provider registry (runtime/providers/registry.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Maps a model slug → { provider, baseUrl, authEnv, modelId, adapter }.
 *
 * Design goals:
 *   1. Zero changes for existing Anthropic callers. Slugs starting with
 *      "claude-" route to the Anthropic adapter (direct or via the cxr
 *      Bedrock proxy at 127.0.0.1:8741, same as today).
 *   2. Users with an API key for any supported provider can switch by
 *      setting GOLDUCK_MODEL=<slug> — or via the /model slash command.
 *   3. Anything OpenAI-compat (GLM, DeepSeek, xAI, Mistral, Groq,
 *      OpenRouter, plus OpenAI itself) shares one adapter.
 *   4. Gemini gets its own adapter (different request / SSE format).
 *   5. A user can register a "custom openai-compat" endpoint through env
 *      vars: GOLDUCK_CUSTOM_BASE_URL + GOLDUCK_CUSTOM_API_KEY +
 *      GOLDUCK_CUSTOM_MODEL.
 *
 * When a slug doesn't match any known pattern we fall back to Anthropic
 * (the historic default) — that preserves behavior for every existing
 * internal call that passes 'claude-opus-4-7' unchanged.
 * ───────────────────────────────────────────────────────────────────────── */

export const PROVIDERS = {
  anthropic: {
    name: 'anthropic',
    // Direct cloud base; the client can still redirect to the cxr proxy
    // when present. See runtime/engine/client.mjs#probeBaseUrl.
    baseUrl: 'https://api.anthropic.com/v1',
    authEnvs: ['ANTHROPIC_API_KEY'],
    adapter: 'anthropic',
    label: 'Anthropic (Claude / Bedrock proxy)',
  },
  openai: {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    authEnvs: ['OPENAI_API_KEY'],
    adapter: 'openai',
    label: 'OpenAI (GPT)',
  },
  glm: {
    name: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authEnvs: ['ZHIPUAI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'],
    adapter: 'openai', // OpenAI-compat dialect
    label: 'Zhipu GLM',
  },
  gemini: {
    name: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    adapter: 'gemini',
    label: 'Google Gemini',
  },
  deepseek: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    authEnvs: ['DEEPSEEK_API_KEY'],
    adapter: 'openai',
    label: 'DeepSeek',
  },
  xai: {
    name: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    authEnvs: ['XAI_API_KEY', 'GROK_API_KEY'],
    adapter: 'openai',
    label: 'xAI (Grok)',
  },
  mistral: {
    name: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    authEnvs: ['MISTRAL_API_KEY'],
    adapter: 'openai',
    label: 'Mistral',
  },
  groq: {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authEnvs: ['GROQ_API_KEY'],
    adapter: 'openai',
    label: 'Groq',
  },
  openrouter: {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authEnvs: ['OPENROUTER_API_KEY'],
    adapter: 'openai',
    label: 'OpenRouter (aggregator)',
  },
  custom: {
    name: 'custom',
    // baseUrl + authEnv + adapter resolved at runtime from env vars.
    baseUrl: null,
    authEnvs: ['GOLDUCK_CUSTOM_API_KEY'],
    adapter: 'openai',
    label: 'Custom (OpenAI-compatible)',
  },
};

/**
 * detectProvider(slug) — rule-based routing from a model slug to a provider
 * spec. Rules apply in order; the first match wins.
 *
 *   "claude-*"                               → anthropic
 *   "gpt-*", "o1-*", "o3-*", "o4-*"          → openai
 *   "glm-*", "chatglm-*"                     → glm
 *   "gemini-*"                               → gemini
 *   "deepseek-*"                             → deepseek
 *   "grok-*"                                 → xai
 *   "mistral-*", "mixtral-*", "codestral-*"  → mistral
 *   "llama-*-groq", ending "-groq"            → groq
 *   contains "/"                             → openrouter (e.g. "meta-llama/…")
 *   matches GOLDUCK_CUSTOM_MODEL             → custom
 *   anything else                            → anthropic (fallback)
 */
export function detectProvider(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return PROVIDERS.anthropic;
  const customModel = (process.env.GOLDUCK_CUSTOM_MODEL || '').toLowerCase();
  if (customModel && s === customModel) {
    return {
      ...PROVIDERS.custom,
      baseUrl: process.env.GOLDUCK_CUSTOM_BASE_URL || PROVIDERS.custom.baseUrl,
    };
  }
  if (/^claude[-/]/.test(s) || s === 'claude') return PROVIDERS.anthropic;
  if (/^(gpt|o1|o3|o4)([-_]|$)/.test(s))        return PROVIDERS.openai;
  if (/^(glm|chatglm)([-_]|$)/.test(s))         return PROVIDERS.glm;
  if (/^gemini([-_]|$)/.test(s))                return PROVIDERS.gemini;
  if (/^deepseek([-_]|$)/.test(s))              return PROVIDERS.deepseek;
  if (/^grok([-_]|$)/.test(s))                  return PROVIDERS.xai;
  if (/^(mistral|mixtral|codestral)([-_]|$)/.test(s)) return PROVIDERS.mistral;
  if (s.endsWith('-groq'))                      return PROVIDERS.groq;
  if (s.includes('/'))                          return PROVIDERS.openrouter;
  return PROVIDERS.anthropic;
}

/**
 * resolveAuthKey(provider) — walks the provider's env list and returns the
 * first non-empty key. Returns null when nothing is configured (Anthropic's
 * Bedrock-proxy path doesn't need a key; the proxy has its own IAM).
 */
export function resolveAuthKey(provider) {
  if (!provider || !Array.isArray(provider.authEnvs)) return null;
  for (const env of provider.authEnvs) {
    const v = process.env[env];
    if (v && String(v).trim().length > 0) return String(v).trim();
  }
  return null;
}

/**
 * resolveBaseUrl(provider, slug) — returns the HTTP base URL for the given
 * provider. Callers can override via GOLDUCK_BASE_URL or a provider-specific
 * env (e.g. OPENAI_BASE_URL). Anthropic has special handling in
 * runtime/engine/client.mjs to also try the local cxr proxy.
 */
export function resolveBaseUrl(provider) {
  if (!provider) return null;
  if (process.env.GOLDUCK_BASE_URL) return process.env.GOLDUCK_BASE_URL;
  // Per-provider override: e.g. OPENAI_BASE_URL, MISTRAL_BASE_URL.
  const envKey = `${provider.name.toUpperCase()}_BASE_URL`;
  if (process.env[envKey]) return process.env[envKey];
  if (provider.name === 'custom') {
    return process.env.GOLDUCK_CUSTOM_BASE_URL || null;
  }
  return provider.baseUrl;
}

/**
 * listProviders() — small summary used by /model, doctor, and the settings
 * overlay. Returns objects of the form { name, label, adapter, hasKey }.
 */
export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    name: p.name,
    label: p.label,
    adapter: p.adapter,
    hasKey: Boolean(resolveAuthKey(p)) || p.name === 'anthropic', // anthropic falls back to cxr
  }));
}
