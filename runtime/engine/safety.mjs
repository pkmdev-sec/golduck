/* ─────────────────────────────────────────────────────────────────────────
 * golduck pre-tool safety check (runtime/engine/safety.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Before invoking destructive tools, we run a fast Opus check to veto
 * obviously-bad operations (rm -rf /, secret exfiltration, force-push to
 * main, etc.). If the check says BLOCK, we return a tool_result with the
 * block reason so the model can try a safer approach instead.
 *
 * Destructive tools:
 *   - shell  (when cmd matches a danger regex)
 *   - apply_patch  (writes files)
 *   - write  (writes files)
 *
 * Non-destructive tools pass through instantly.
 * ───────────────────────────────────────────────────────────────────────── */
import { streamMessages, buildRequestBody } from './client.mjs';
import { event } from '../trace/tracer.mjs';
import { HARD_BLOCK_PATTERNS, findHardBlock, findSecret } from '../governance/patterns.mjs';
import { safeJsonParse } from './json_parse.mjs';
import crypto from 'node:crypto';
import { resolveModel } from './model_policy.mjs';
// Main sub-system model is resolved per-call via resolveModel().

// Verdict cache: (toolName + stable-hash-of-input) → { verdict, expiresAt }.
const _safetyCache = new Map();
const SAFETY_CACHE_TTL_MS = parseInt(process.env.GOLDUCK_SAFETY_CACHE_TTL_MS || '300000', 10); // 5 min
function _cacheKey(toolName, input) {
  const h = crypto.createHash('sha1').update(JSON.stringify(input || {})).digest('hex');
  return toolName + '::' + h;
}
function _cacheGet(k) {
  const e = _safetyCache.get(k);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { _safetyCache.delete(k); return null; }
  return e.verdict;
}
function _cacheSet(k, verdict) {
  _safetyCache.set(k, { verdict, expiresAt: Date.now() + SAFETY_CACHE_TTL_MS });
  // Bound size.
  if (_safetyCache.size > 256) {
    const oldest = _safetyCache.keys().next().value;
    _safetyCache.delete(oldest);
  }
}
export function _resetSafetyCacheForTests() { _safetyCache.clear(); }


export function isDestructive(toolName, input) {
  if (toolName === 'apply_patch') return true;
  if (toolName === 'write') return true;
  if (toolName === 'shell') {
    const cmd = input?.command || '';
    // Light filter: anything that writes, deletes, pushes, or elevates.
    return /\b(rm|mv|chmod|chown|chattr|install|curl|wget|git\s+push|git\s+reset|git\s+checkout|npm\s+publish|pnpm\s+publish|gh\s+release|sudo|doas|pkexec)\b/.test(cmd)
        || /[>|&]/.test(cmd) // redirection/pipes often write
        || HARD_BLOCK_PATTERNS.some((re) => re.test(cmd));
  }
  return false;
}

export function hardBlock(toolName, input) {
  if (toolName !== 'shell') return null;
  const cmd = input?.command || '';
  const finding = findHardBlock(cmd);
  if (finding) return `hard-block pattern: ${finding.pattern}`;
  return null;
}

/** Returns {allow, reason}. Never throws; on sub-agent error, allow. */
export async function safetyCheck({ toolName, input, userIntent }) {
  const hb = hardBlock(toolName, input);
  if (hb) {
    event('safety.hard_block', { tool: toolName, reason: hb });
    return { allow: false, reason: `hard-blocked: ${hb}` };
  }
  // Outbound secret scan — block if the tool input carries a recognizable secret.
  try {
    const sniff = findSecret(JSON.stringify(input || {}));
    if (sniff) {
      event('safety.secret_sniffed', { tool: toolName, match: sniff.match });
      return { allow: false, reason: `tool input contains what looks like a secret (${sniff.match}); remove before dispatch` };
    }
  } catch {}
  if (!isDestructive(toolName, input)) return { allow: true };

  // Cache: repeated identical destructive calls share one Opus verdict.
  const key = _cacheKey(toolName, input);
  const hit = _cacheGet(key);
  if (hit) {
    event('safety.cache_hit', { tool: toolName });
    return hit;
  }

  const system = [{
    type: 'text',
    text:
      'You are a safety checker. You will be shown a proposed tool call from an autonomous agent ' +
      'and the user intent. Decide if executing it is safe + appropriate. ' +
      'Return STRICT JSON: {"allow": true|false, "reason": "..."} — no prose outside JSON. ' +
      'Allow unless you see a clear risk: data loss (rm -rf on large scopes), credentials exfiltration, ' +
      'irreversible writes unrelated to the user intent, or force-push to a shared branch.',
  }];
  const user = {
    role: 'user',
    content:
      `# User intent\n${(userIntent || '(unknown)').slice(0, 1500)}\n\n` +
      `# Proposed tool\n${toolName}\n\n` +
      `# Tool input\n${JSON.stringify(input, null, 2).slice(0, 4000)}\n\nEmit the JSON verdict.`,
  };
  try {
    const body = buildRequestBody({
      model: resolveModel(), system,
      messages: [user],
      max_tokens: 1500,
      temperature: 1.0,
    });
    const it = streamMessages(body);
    let text = '';
    for await (const ev of it) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
    }
    const json = safeJsonParse(text, { fallback: { allow: true, reason: 'safety-check unparseable verdict; allowing' } });
    event('safety.verdict', { tool: toolName, allow: Boolean(json.allow), reason: (json.reason || '').slice(0, 200) });
    _cacheSet(key, json);
    return json;
  } catch (e) {
    event('safety.check_failed', { tool: toolName, error: String(e).slice(0, 200) });
    // Fail-open: if the safety check itself errors, we still let the
    // engine-level gate + user-visible tool-call UI catch problems.
    return { allow: true, reason: 'safety-check errored; allowing' };
  }
}
