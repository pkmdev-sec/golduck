/* ─────────────────────────────────────────────────────────────────────────
 * golduck auto fact extractor (runtime/memory/fact_extract.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * When a turn ends with verdict=approve, we asynchronously ask a fast
 * Opus sub-call to distill 0-3 *durable* facts from the interaction and
 * append them to memory/facts.jsonl. This is how the recall corpus
 * actually grows during use — before this module existed, facts.jsonl
 * had no writer at all.
 *
 * Design:
 *   - Fire-and-forget: callers MUST NOT await this; we schedule + return.
 *   - Budget-gated: skips below $0.20 remaining.
 *   - Size-gated: skips if the turn was trivial (<400 final chars).
 *   - Dedupe-ish: we load the last 50 facts and reject near-duplicates
 *     via naive token-overlap > 0.6.
 *
 * Fact shape:  { ts, fact, tags, source: 'auto_extract', run_id }
 *
 * Fail-open: any error logs to tracer and silently ends.
 * ───────────────────────────────────────────────────────────────────────── */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { safeJsonParse } from '../engine/json_parse.mjs';
import { event } from '../trace/tracer.mjs';

import { resolveModel } from '../engine/model_policy.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const FACTS = () => join(HOME(), 'memory', 'facts.jsonl');
// MODEL is now resolved per-call via resolveModel() so /model propagates.

function tokenize(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
}

function overlap(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

function loadRecentFacts(limit = 50) {
  try {
    if (!existsSync(FACTS())) return [];
    const raw = readFileSync(FACTS(), 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch {}
    }
    return out.slice(-limit);
  } catch { return []; }
}

function appendFacts(facts, source) {
  try {
    const f = FACTS();
    mkdirSync(dirname(f), { recursive: true });
    const runId = process.env.GOLDUCK_RUN_ID || null;
    const ts = new Date().toISOString();
    const body = facts.map((fact) => JSON.stringify({
      ts, fact: String(fact).slice(0, 280), tags: [], source, run_id: runId,
    })).join('\n') + '\n';
    appendFileSync(f, body);
  } catch (e) {
    event('fact_extract.write_error', { msg: String(e).slice(0, 200) });
  }
}

/** Schedules an async fact-extraction for an approved turn.
 *  Returns immediately; do NOT await. */
// Also bail when the per-process RLM budget is already exhausted — no point
// accruing more spend on memory-side work once the quality loop is out of runway.
import { rlmSpend } from '../tools/rlm.mjs';
const RLM_BUDGET_SOFT_CAP_USD = parseFloat(process.env.GOLDUCK_RLM_BUDGET_USD || '5');

export function scheduleFactExtract({ userIntent, finalAnswer, budgetRemaining }) {
  try {
    if (RLM_BUDGET_SOFT_CAP_USD > 0 && rlmSpend() >= RLM_BUDGET_SOFT_CAP_USD * 0.9) {
      event('fact_extract.skip', { reason: 'rlm_budget_near_cap', spent: rlmSpend() });
      return;
    }
  } catch {}
  if (process.env.GOLDUCK_DISABLE_FACT_EXTRACT === '1') return;
  if (!finalAnswer || finalAnswer.length < 400) return;
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.2) return;

  // Fire-and-forget via setImmediate so the calling turn isn't blocked.
  setImmediate(async () => {
    try {
      const system = [{ type: 'text', text:
        'You extract durable facts from an AI/user interaction. Output ONLY a JSON array of 0–3 short (<=180 char) facts. ' +
        'Each fact must be a stable, project/user truth — NOT an ephemeral turn detail. ' +
        'Skip facts that are already implicit in general knowledge. Return [] if none apply. No prose outside JSON.'
      }];
      const user =
        '# User request\n' + String(userIntent || '').slice(0, 2000) + '\n\n' +
        '# Final assistant answer\n' + String(finalAnswer || '').slice(0, 6000) + '\n\n' +
        'Emit the JSON array.';
      const body = buildRequestBody({
        model: resolveModel(), system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 1200,
        temperature: 1.0,
      });
      const it = streamMessages(body);
      let text = '';
      for await (const ev of it) {
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
      }
      const parsed = safeJsonParse(text);
      if (!Array.isArray(parsed)) { event('fact_extract.unparseable', { raw: text.slice(0, 200) }); return; }

      // Dedupe against last 50 facts.
      const recent = loadRecentFacts(50).map((r) => r.fact || '');
      const fresh = parsed
        .map((x) => String(x || '').trim())
        .filter((x) => x.length >= 8 && x.length <= 280)
        .filter((x) => !recent.some((r) => overlap(x, r) > 0.6));
      if (!fresh.length) { event('fact_extract.no_fresh', { candidates: parsed.length }); return; }

      appendFacts(fresh.slice(0, 3), 'auto_extract');
      event('fact_extract.appended', { count: Math.min(3, fresh.length) });
    } catch (e) {
      event('fact_extract.error', { msg: String(e).slice(0, 200) });
    }
  });
}
