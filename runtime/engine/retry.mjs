/* ─────────────────────────────────────────────────────────────────────────
 * golduck retry policy (runtime/engine/retry.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Centralized retry wrapper for LLM calls. Handles transient failures
 * gracefully so a long agent run doesn't die from a single hiccup:
 *
 *   - HTTP 429 / 5xx → exponential backoff with jitter
 *   - Network errors (ECONNRESET, ETIMEDOUT, socket hang up) → retry
 *   - AbortError / signal-based cancellation → NO retry
 *   - invalid_request_error (4xx) → NO retry (it's a real bug)
 *
 * Budget: 4 attempts max. Each attempt waits base * 2^(attempt-1) +
 * random(0..250)ms, capped at 20s.
 *
 * Emits `retry.attempt` + `retry.give_up` trace events.
 * ───────────────────────────────────────────────────────────────────────── */
import { event } from '../trace/tracer.mjs';

const MAX_ATTEMPTS = parseInt(process.env.GOLDUCK_RETRY_MAX || '4', 10);
const BASE_DELAY_MS = 800;
const CAP_DELAY_MS = 20_000;

// Circuit breaker: once N consecutive failures land within WINDOW ms, the next
// request fails fast for COOL ms instead of retrying. Reset on any success.
const CB_FAILS = parseInt(process.env.GOLDUCK_CB_FAILS || '6', 10);
const CB_WINDOW_MS = 60_000;
const CB_COOL_MS = parseInt(process.env.GOLDUCK_CB_COOL_MS || '15000', 10);
const cbFails = [];
let cbOpenUntil = 0;

function circuitOpen() {
  const now = Date.now();
  if (now < cbOpenUntil) return true;
  // Trim out-of-window failures.
  while (cbFails.length && now - cbFails[0] > CB_WINDOW_MS) cbFails.shift();
  if (cbFails.length >= CB_FAILS) {
    cbOpenUntil = now + CB_COOL_MS;
    event('retry.circuit_open', { until: cbOpenUntil, cool_ms: CB_COOL_MS });
    return true;
  }
  return false;
}
function recordFailure() { cbFails.push(Date.now()); }
function recordSuccess() { cbFails.length = 0; cbOpenUntil = 0; }

/** Parse a Retry-After header-ish hint off an error message. Bedrock and
 *  Anthropic both put the hint inline when they rate-limit. Returns ms or 0. */
function retryAfterMs(err) {
  const msg = String(err?.message || err || '');
  const m = msg.match(/retry[-_ ]after[:=]\s*(\d+)(?:\s*ms)?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    // Heuristic: values > 1000 look like ms; smaller look like seconds.
    return Number.isFinite(n) ? (n > 1000 ? n : n * 1000) : 0;
  }
  return 0;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function shouldRetry(err) {
  const msg = (err?.message || String(err || '')).toLowerCase();
  if (err?.name === 'AbortError') return false;
  if (msg.includes('invalid_request_error')) return false;
  if (msg.includes('no api key found')) return false;       // provider-registry miss
  if (msg.includes('no base url configured')) return false; // custom provider misconfig
  if (msg.includes('unknown provider adapter')) return false;
  if (msg.includes('max_tokens') && msg.includes('too large')) return false;
  if (msg.includes('invalid api key') || msg.includes('api key is invalid')) return false;
  if (msg.includes('400 ')) return false;
  if (msg.includes('401') || msg.includes('403')) return false;
  if (msg.includes('404')) return false;
  // Retry on: 429, 500, 502, 503, 504, econnreset, etimedout, socket hang up,
  // stream/network hiccups, timeouts.
  if (/\b(429|5\d\d)\b/.test(msg)) return true;
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) return true;
  if (msg.includes('network') || msg.includes('timeout')) return true;
  if (msg.includes('stream')) return true;
  // Default: retry unknown transients once (first attempt only). We give
  // up quickly for unknown non-5xx errors because they're usually bugs.
  return false;
}

export async function withRetry(name, fn, ctx = {}) {
  let lastErr = null;
  const onAttempt = typeof ctx?.onAttempt === 'function' ? ctx.onAttempt : null;
  if (circuitOpen()) {
    const err = new Error('circuit_open: upstream failing repeatedly; backing off');
    err.circuitOpen = true;
    event('retry.circuit_short_circuit', { name });
    throw err;
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fn();
      recordSuccess();
      return r;
    } catch (e) {
      lastErr = e;
      const retryable = shouldRetry(e);
      const reason = (e?.message || String(e)).slice(0, 200);
      event('retry.attempt', { name, attempt, retryable, error: reason });
      if (!retryable || attempt === MAX_ATTEMPTS) { recordFailure(); break; }
      // Retry-After hint wins over our exp-backoff if the server gave us one.
      const hinted = retryAfterMs(e);
      const expBack = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), CAP_DELAY_MS);
      const delay = Math.max(hinted || 0, expBack) + Math.floor(Math.random() * 250);
      if (onAttempt) { try { onAttempt({ attempt, reason, wait_ms: delay }); } catch {} }
      await sleep(delay);
    }
  }
  event('retry.give_up', { name, after: MAX_ATTEMPTS, error: (lastErr?.message || String(lastErr)).slice(0, 200) });
  throw lastErr;
}
