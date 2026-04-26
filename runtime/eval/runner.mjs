/* ─────────────────────────────────────────────────────────────────────────
 * golduck eval runner (runtime/eval/runner.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Runs every golden prompt through the native engine client (tools-disabled
 * mode for deterministic comparison), then scores each answer with
 * rlm_verify against the prompt's `expect` rubric.
 *
 * Produces a report:
 *   {
 *     at, wave, model,
 *     runs: [{ id, tier, prompt, answer, score, verdict, issues[], latency_ms, usd }],
 *     totals: { mean_score, approve_rate, revise_rate, usd, wall_ms }
 *   }
 *
 * Persisted to `$GOLDUCK_HOME/eval/runs/<timestamp>.json`.
 * Latest report is also copied to `$GOLDUCK_HOME/eval/latest.json` for
 * easy `golduck eval --diff` comparisons.
 *
 * Score rubric (emitted by judge):
 *   approve  → 1.0
 *   revise   → 0.4  (has substance but misses/misstates something)
 *   unknown  → 0.0  (judge couldn't decide)
 * Confidence-weighted: final score = rubric * (0.5 + 0.5 * confidence).
 * ───────────────────────────────────────────────────────────────────────── */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { rlm_verify } from '../tools/rlm.mjs';
import { GOLDEN } from './golden.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const MODEL = 'claude-opus-4-7';

function scoreOf(verdict) {
  if (!verdict) return 0;
  const v = verdict.verdict || verdict.kind || 'unknown';
  const conf = Math.max(0, Math.min(1, Number(verdict.confidence) || 0));
  const rubric = v === 'approve' ? 1.0 : v === 'revise' ? 0.4 : 0.0;
  return rubric * (0.5 + 0.5 * conf);
}

async function answerOne({ prompt, thinking_budget }) {
  const started = Date.now();
  const body = buildRequestBody({
    model: MODEL,
    system: [{ type: 'text', text:
      'You are being evaluated. Answer the prompt directly, rigorously, and concretely. ' +
      'No meta commentary about the evaluation itself; just solve the problem as asked.' }],
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8000,
    thinking: { type: 'enabled', budget_tokens: thinking_budget },
    temperature: 1.0,
  });
  const iter = streamMessages(body, { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } });
  let text = '';
  let usage = {};
  for await (const ev of iter) {
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
    if (ev.type === 'message_delta' && ev.usage) usage = { ...usage, ...ev.usage };
  }
  const latency_ms = Date.now() - started;
  const usd = ((usage.input_tokens || 0) * 15 + (usage.output_tokens || 0) * 75) / 1_000_000;
  return { answer: text.trim(), latency_ms, usd, usage };
}

async function judgeOne({ prompt, expect, answer }) {
  // rlm_verify judges against a question+answer+rubric. We wrap the rubric
  // into the question so the judge sees what "correct" means for this item.
  const q = `${prompt}\n\n# Grading rubric (for the judge)\n${expect}\n\n# INSTRUCTIONS TO JUDGE\nEvaluate strictly against the rubric. If the answer meets every must-have in the rubric, approve with high confidence. If it misses ANY must-have, revise. Confidence should reflect how far off the answer is.`;
  return rlm_verify({ question: q, answer, model: 'opus' });
}

export async function runEval({ tiers = null, verbose = false, onProgress = null } = {}) {
  const items = tiers && tiers.length
    ? GOLDEN.filter((g) => tiers.includes(g.tier))
    : GOLDEN.slice();
  if (!items.length) return { error: 'no prompts selected' };

  const wallStart = Date.now();
  const runs = [];
  let totalUsd = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const thinking_budget = item.tier === 'hard' ? 32000 : item.tier === 'medium' ? 16000 : 8000;
    if (onProgress) onProgress({ i, n: items.length, id: item.id, phase: 'answer' });
    let record;
    try {
      const ans = await answerOne({ prompt: item.prompt, thinking_budget });
      if (onProgress) onProgress({ i, n: items.length, id: item.id, phase: 'judge' });
      const verdict = await judgeOne({ prompt: item.prompt, expect: item.expect, answer: ans.answer });
      const score = Math.round(scoreOf(verdict) * 1000) / 1000;
      record = {
        id: item.id, tier: item.tier,
        prompt: item.prompt,
        answer: ans.answer,
        answer_chars: ans.answer.length,
        score,
        verdict: verdict?.verdict || 'unknown',
        confidence: verdict?.confidence ?? 0,
        issues: Array.isArray(verdict?.issues) ? verdict.issues.slice(0, 6) : [],
        latency_ms: ans.latency_ms,
        usd: ans.usd,
      };
      totalUsd += ans.usd;
      if (verbose) {
        console.log(`  ${item.id.padEnd(4)} [${item.tier.padEnd(6)}] score=${score.toFixed(2)} verdict=${record.verdict} conf=${record.confidence.toFixed(2)} ${record.issues.length ? '· issues=' + record.issues.length : ''}`);
      }
    } catch (e) {
      record = {
        id: item.id, tier: item.tier, error: String(e).slice(0, 200),
        score: 0, verdict: 'error', issues: [String(e).slice(0, 120)],
        latency_ms: 0, usd: 0,
      };
      if (verbose) console.log(`  ${item.id.padEnd(4)} [${item.tier.padEnd(6)}] ERROR: ${record.error}`);
    }
    runs.push(record);
  }

  const wall_ms = Date.now() - wallStart;
  const scored = runs.filter((r) => !r.error);
  const mean = scored.length ? scored.reduce((a, r) => a + r.score, 0) / scored.length : 0;
  const approveRate = scored.length ? scored.filter((r) => r.verdict === 'approve').length / scored.length : 0;
  const reviseRate = scored.length ? scored.filter((r) => r.verdict === 'revise').length / scored.length : 0;

  const report = {
    at: new Date().toISOString(),
    wave: process.env.GOLDUCK_WAVE || 'unversioned',
    model: MODEL,
    runs,
    totals: {
      n: runs.length,
      scored: scored.length,
      mean_score: Math.round(mean * 1000) / 1000,
      approve_rate: Math.round(approveRate * 1000) / 1000,
      revise_rate: Math.round(reviseRate * 1000) / 1000,
      usd: Math.round(totalUsd * 10000) / 10000,
      wall_ms,
    },
  };

  // Persist.
  try {
    const dir = join(HOME(), 'eval', 'runs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${report.at.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    const latest = join(HOME(), 'eval', 'latest.json');
    writeFileSync(latest, JSON.stringify(report, null, 2));
    report._file = file;
  } catch {}

  return report;
}

/**
 * Compare two reports (typically "latest" vs "previous").
 * Returns { delta_mean, regressed: [{id, from, to}], improved: [{id, from, to}] }.
 */
export function diffReports(a, b) {
  if (!a || !b) return { error: 'missing report(s)' };
  const byIdA = new Map(a.runs.map((r) => [r.id, r]));
  const byIdB = new Map(b.runs.map((r) => [r.id, r]));
  const ids = new Set([...byIdA.keys(), ...byIdB.keys()]);
  const regressed = [];
  const improved = [];
  for (const id of ids) {
    const ra = byIdA.get(id); const rb = byIdB.get(id);
    if (!ra || !rb) continue;
    if (rb.score - ra.score > 0.05) improved.push({ id, from: ra.score, to: rb.score });
    if (ra.score - rb.score > 0.05) regressed.push({ id, from: ra.score, to: rb.score });
  }
  return {
    delta_mean: Math.round((b.totals.mean_score - a.totals.mean_score) * 1000) / 1000,
    from_mean: a.totals.mean_score,
    to_mean: b.totals.mean_score,
    regressed, improved,
  };
}

/** Load the two most recent reports for a diff. */
export function loadRecentReports(k = 2) {
  try {
    const dir = join(HOME(), 'eval', 'runs');
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, k);
    return files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
  } catch { return []; }
}
