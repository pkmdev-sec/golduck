/* ─────────────────────────────────────────────────────────────────────────
 * golduck best-of-N terminal sampling (runtime/engine/best_of_n.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * When the engine reaches a *terminal* turn (stop_reason = end_turn, no
 * tool_use, verdict pending), we can optionally draw N additional samples
 * of the final answer in parallel, have the rlm_verify panel score each,
 * and ship the highest-confidence sample back to the user.
 *
 * Trigger (narrow by design — never fire on trivial turns):
 *   routed.reflect === 'deep'     AND
 *   had at least one tool round   AND     (the run did real work)
 *   finalAnswer length >= 400 chars AND    (the answer is substantial)
 *   budgetRemaining >= $0.50              (room to burn ~2 extra samples)
 *
 * Sampling strategy:
 *   - Draw N=2 additional samples (caller-configurable, capped at 3).
 *   - Reuse the same system + messages prefix, but do NOT feed the prior
 *     assistantContent back — we want the model to start fresh.
 *   - Temperature spread (1.0, 1.0) — Opus 4.7 doesn't expose a seed, so
 *     we inject a tiny "variation prompt suffix" into the final user
 *     message to nudge a different decoding path per sample.
 *   - After sampling, run rlm_verify on {original, samples...} and pick
 *     the highest-confidence `approve`; tie-break on fewest issues.
 *
 * Fail-open: any error here leaves the original answer intact.
 * ───────────────────────────────────────────────────────────────────────── */

import { streamMessages, buildRequestBody } from './client.mjs';
import { withRetry } from './retry.mjs';
import { rlm_verify } from '../tools/rlm.mjs';
import { event } from '../trace/tracer.mjs';

const MAX_SAMPLES = 3;

/**
 * Adaptive sample count: reads the initial rlm_verify on the ORIGINAL
 * answer and decides how many extra samples are worth drawing.
 *
 * Logic:
 *   - Original verdict approve + confidence ≥ 0.85 → 0 samples (skip).
 *   - Original verdict approve + confidence ≥ 0.65 → 1 sample.
 *   - Otherwise (approve low-conf OR revise OR unknown) → 2 samples.
 *   - Capped at MAX_SAMPLES.
 *
 * Caller passes the priorVerdict (from autoVerify.v.verdict). If none,
 * defaults to the `fallback` param (default 2) for backward compat.
 */
export function adaptiveSamples(priorVerdict, fallback = 2) {
  if (!priorVerdict) return Math.min(MAX_SAMPLES, fallback);
  const v = priorVerdict.verdict || priorVerdict.kind;
  const c = Number(priorVerdict.confidence) || 0;
  if (v === 'approve' && c >= 0.85) return 0;
  if (v === 'approve' && c >= 0.65) return 1;
  if (v === 'revise') return Math.min(MAX_SAMPLES, 2);
  return Math.min(MAX_SAMPLES, 2);
}

function cloneMessagesForSample(messages, nudge) {
  // Drop the last assistant message (the answer we're trying to beat).
  const out = [];
  let droppedLast = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (i === messages.length - 1 && m.role === 'assistant') { droppedLast = true; continue; }
    out.push(m);
  }
  if (!droppedLast) return messages; // no prior assistant? odd, but don't mutate.
  // Append a tiny nudge to the last user message so this sample takes a
  // different decoding path. We do NOT remove any content.
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    out[out.length - 1] = {
      ...last,
      content: content + '\n\n[golduck:sample-nudge] Consider an alternative framing for your answer.' + nudge,
    };
  }
  return out;
}

function _sampleTemperature(i) {
  const spread = String(process.env.GOLDUCK_BON_TEMPERATURE_SPREAD || '').split(',').map((x) => parseFloat(x)).filter(Number.isFinite);
  if (spread.length) return spread[i % spread.length];
  // Default: alternate 1.0 / 0.8 / 1.2 so samples draw different paths even
  // though Opus 4.7 doesn't expose a seed.
  return [1.0, 0.8, 1.2][i % 3];
}

async function oneSample({ model, system, messages, thinking, max_tokens, nudge, sampleIndex = 0 }) {
  const body = buildRequestBody({
    model, system,
    messages: cloneMessagesForSample(messages, nudge),
    tools: null, // terminal turn — no tools.
    thinking,
    max_tokens,
    temperature: _sampleTemperature(sampleIndex),
  });
  const iter = await withRetry('best_of_n.sample', () => streamMessages(body, {
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  }));
  let text = '';
  for await (const ev of iter) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      text += ev.delta.text || '';
    }
  }
  return text.trim();
}

/**
 * Try to improve a terminal answer via N extra samples + verifier scoring.
 * Returns { kind, best, candidates, verdicts } where:
 *   kind = 'kept_original' | 'replaced'
 *   best = the winning answer text
 *   candidates = [{ source, text }]  — includes the original
 *   verdicts = [{ source, verdict }] — one per candidate
 * On error or trigger not met: returns { kind: 'skip', reason }.
 */
export async function maybeBestOfN({
  model, system, messages, thinking, max_tokens,
  userIntent, finalAnswer, hadToolRounds, budgetRemaining,
  reflect, samples = 2,
}) {
  if (reflect !== 'deep')      return { kind: 'skip', reason: 'reflect_not_deep' };
  if (!hadToolRounds)          return { kind: 'skip', reason: 'no_tool_rounds' };
  if (!finalAnswer || finalAnswer.length < 400) return { kind: 'skip', reason: 'answer_too_short' };
  // Budget guard disabled — quality-first mode: always run best-of-N when
  // all other triggers fire. Re-enable with GOLDUCK_ENFORCE_BUDGET=1.
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.5) {
    return { kind: 'skip', reason: 'budget_low' };
  }

  const n = Math.max(1, Math.min(MAX_SAMPLES, samples | 0));
  event('best_of_n.start', { samples: n, answer_chars: finalAnswer.length });

  let extraSamples;
  try {
    extraSamples = await Promise.all(
      Array.from({ length: n }, (_, i) => oneSample({
        model, system, messages, thinking, max_tokens,
        nudge: ` [variant ${i + 1}/${n}]`,
        sampleIndex: i,
      })),
    );
  } catch (e) {
    event('best_of_n.sample_error', { msg: String(e) });
    return { kind: 'skip', reason: 'sample_error' };
  }

  const candidates = [
    { source: 'original', text: finalAnswer },
    ...extraSamples.map((t, i) => ({ source: `variant_${i + 1}`, text: t })),
  ].filter((c) => c.text && c.text.trim().length > 0);

  if (candidates.length < 2) return { kind: 'skip', reason: 'no_viable_samples' };

  // Verify each candidate in parallel.
  const verdicts = await Promise.all(candidates.map(async (c) => {
    try {
      const v = await rlm_verify({ question: String(userIntent).slice(0, 2000), answer: c.text.slice(0, 20000), model: 'opus' });
      return { source: c.source, verdict: v };
    } catch (e) {
      return { source: c.source, verdict: { verdict: 'unknown', confidence: 0, issues: [] } };
    }
  }));

  // Score: approve > revise > unknown; tie-break by (confidence desc, issue_count asc, chars desc).
  function score(v) {
    const kind = v?.verdict?.verdict || v?.verdict?.kind || 'unknown';
    const kindRank = kind === 'approve' ? 2 : kind === 'revise' ? 1 : 0;
    const conf = Number(v?.verdict?.confidence) || 0;
    const issues = Array.isArray(v?.verdict?.issues) ? v.verdict.issues.length : 99;
    return [kindRank, conf, -issues];
  }
  function compare(a, b) {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return sb[i] - sa[i];
    }
    return 0;
  }
  const ranked = [...verdicts].sort(compare);
  const winner = ranked[0];
  const winCandidate = candidates.find((c) => c.source === winner.source);

  event('best_of_n.result', {
    samples: candidates.length,
    winner: winner.source,
    winner_conf: winner.verdict?.confidence,
    kept_original: winner.source === 'original',
  });

  return {
    kind: winner.source === 'original' ? 'kept_original' : 'replaced',
    best: winCandidate.text,
    candidates,
    verdicts,
    winner: winner.source,
  };
}
