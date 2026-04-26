/* ─────────────────────────────────────────────────────────────────────────
 * golduck structured tracer (runtime/trace/tracer.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * JSONL trace writer. Every event is a JSON object on its own line:
 *
 *   { ts, run_id, kind, name, ...payload }
 *
 * `span(name)` returns a handle with .end(payload) — emits {enter,exit}
 * events flanking a named region. All IO is fire-and-forget, O(1) per
 * event, so it's safe to call from hot paths.
 *
 * `golduck trace --follow` tails the current trace and renders it
 * human-readably. Tools can consume the raw JSONL directly.
 * ───────────────────────────────────────────────────────────────────────── */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

let RUN_ID = null;
let TRACE_FILE = null;
let ENABLED = true;

export function openTrace({ runId, traceFile }) {
  RUN_ID = runId || process.env.GOLDUCK_RUN_ID || randomUUID().slice(0, 12);
  TRACE_FILE = traceFile || process.env.GOLDUCK_TRACE_FILE;
  if (!TRACE_FILE) { ENABLED = false; return; }
  try { mkdirSync(dirname(TRACE_FILE), { recursive: true }); } catch {}
  // Expose a minimal tracer hook on globalThis so modules that can't import us
  // (e.g. mcp/client) still get their events through without an import cycle.
  try { globalThis.__golduckTrace = { event }; } catch {}
  event('trace.open', { run_id: RUN_ID });
}

/** Safe JSON.stringify: handles circular refs + BigInt by substituting. */
function _safeStringify(obj) {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_k, v) => {
    if (typeof v === 'bigint') return String(v) + 'n';
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

export function event(name, payload = {}) {
  if (!ENABLED || !TRACE_FILE) return;
  let line;
  try {
    line = _safeStringify({
      ts: new Date().toISOString(),
      run_id: RUN_ID,
      kind: 'event',
      name,
      ...payload,
    }) + '\n';
  } catch (e) {
    // Last-resort fallback — write a stub so the event count stays accurate.
    line = JSON.stringify({ ts: new Date().toISOString(), run_id: RUN_ID, kind: 'event', name, _stringify_error: String(e).slice(0, 200) }) + '\n';
  }
  try { appendFileSync(TRACE_FILE, line); } catch {}
}

export function span(name, payload = {}) {
  const started = Date.now();
  event('span.enter', { span: name, ...payload });
  return {
    end(p2 = {}) {
      event('span.exit', { span: name, duration_ms: Date.now() - started, ...p2 });
    },
  };
}

export function closeTrace() {
  event('trace.close', {});
  ENABLED = false;
}
