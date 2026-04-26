/* ─────────────────────────────────────────────────────────────────────────
 * golduck RLM tools (runtime/tools/rlm.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Recursive-LM primitives. Each sub-agent is a single non-streaming
 * /v1/messages call to the same proxy. No tools exposed to sub-agents
 * by default — keeps sub-problems self-contained.
 *
 * Primitives:
 *   spawn_agent(prompt, context?)         a focused sub-agent
 *   rlm_query(context, query)             scoped sub-query
 *   rlm_map(contexts[], query)            N parallel sub-queries
 *   rlm_verify(question, answer)          panel critic (reviewer+adversary+synth)
 *   rlm_propose(problem, n)               N distinct decomposition strategies
 *   uncertain_so_recurse(q, reason)       decomposition plan
 * ───────────────────────────────────────────────────────────────────────── */
import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { safeJsonParse } from '../engine/json_parse.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveRole, listRoles } from './roles.mjs';

const DEPTH_CAP = parseInt(process.env.GOLDUCK_RLM_DEPTH_CAP || '4', 10);
const DEFAULT_FANOUT_CAP = 20;
const DEFAULT_MAP_CONCURRENCY = 4;

/** Resolves the fanout cap from (in order): env var set by the orchestrator
 *  from routed.fanout_cap, explicit override, or DEFAULT_FANOUT_CAP. */
function currentFanoutCap() {
  const env = parseInt(process.env.GOLDUCK_FANOUT_CAP || '0', 10);
  return env > 0 ? env : DEFAULT_FANOUT_CAP;
}

/** Max number of sub-agents to run concurrently for rlm_map. */
function currentMapConcurrency() {
  const env = parseInt(process.env.GOLDUCK_MAP_CONCURRENCY || '0', 10);
  return env > 0 ? env : DEFAULT_MAP_CONCURRENCY;
}

// ── Per-process RLM cost ledger ────────────────────────────────────────────
// Tracks USD spent across every sub-agent call in this orchestrator process.
// When the running total crosses GOLDUCK_RLM_BUDGET_USD, guardDepthAndFanout
// throws "rlm budget exhausted" and callers surface the standard hint.
// Default cap of $5 guards against runaway spawns. Set to 0 to disable.
const RLM_PRICE = { in: 15, out: 75, cr: 1.5, cw: 18.75 }; // Opus 4.7 per 1M
function _rlmBudgetCap() {
  const env = parseFloat(process.env.GOLDUCK_RLM_BUDGET_USD || '5');
  return Number.isFinite(env) ? env : 5;
}
const _rlmSpend = { usd: 0 };
export function rlmSpend() { return _rlmSpend.usd; }
export function _resetRlmSpendForTests() { _rlmSpend.usd = 0; }
function _accrueSpend(usage) {
  if (!usage) return;
  const u = (usage.input_tokens || 0) * RLM_PRICE.in +
            (usage.output_tokens || 0) * RLM_PRICE.out +
            (usage.cache_read_input_tokens || 0) * RLM_PRICE.cr +
            (usage.cache_creation_input_tokens || 0) * RLM_PRICE.cw;
  _rlmSpend.usd += u / 1_000_000;
}

/** Runs an async function under a concurrency gate: at most `n` of `fns`
 *  are in flight at once. Returns results in the original order. */
async function _boundedMap(fns, n) {
  const results = new Array(fns.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, fns.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= fns.length) return;
      try { results[i] = await fns[i](); }
      catch (e) { results[i] = { ok: false, error: e?.message || String(e) }; }
    }
  });
  await Promise.all(workers);
  return results;
}

// Per-async-context depth tracking. Each nested call runs inside
// depthStore.run(depth+1, ...) so parallel siblings all see the
// caller's depth and never race on a shared counter.
const depthStore = new AsyncLocalStorage();
function currentDepth() { return depthStore.getStore() ?? 0; }
function withDepth(nextDepth, fn) { return depthStore.run(nextDepth, fn); }

async function callSub({ system, user, model = 'claude-sonnet-4-5-20250929', max_tokens = 8000, thinking = null }) {
  // Per-process RLM budget: bail BEFORE issuing the call if we'd exceed.
  const cap = _rlmBudgetCap();
  if (cap > 0 && _rlmSpend.usd >= cap) {
    throw new Error(`rlm budget exhausted (spent=${_rlmSpend.usd.toFixed(4)}, cap=${cap})`);
  }
  const body = buildRequestBody({
    model,
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens,
    thinking,
    temperature: 1.0,
  });
  const it = streamMessages(body);
  let text = '', thinkingText = '', usage = {};
  for await (const ev of it) {
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage };
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') text += ev.delta.text || '';
      if (ev.delta?.type === 'thinking_delta') thinkingText += ev.delta.thinking || '';
    }
    if (ev.type === 'message_delta') {
      if (ev.usage) usage = { ...usage, ...ev.usage };
    }
  }
  _accrueSpend(usage);
  return { text: text.trim(), thinking: thinkingText.trim(), usage };
}

// ────── schemas ───────────────────────────────────────────────────────────

export const SCHEMAS = [
  {
    name: 'spawn_agent',
    description:
      'Spawn a focused sub-agent for a scoped sub-problem. Returns the sub-agent final text. ' +
      'Use this when you want the sub-agent to work on a focused slice of the problem in isolation. ' +
      'Pass `role` to use a specialized system prompt (e.g. security-reviewer, perf-analyst, test-writer, ' +
      'api-designer, doc-writer). Custom roles are loaded from $GOLDUCK_HOME/roles/<name>.md.',
    input_schema: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: { type: 'string' },
        context: { type: 'string', description: 'Optional context to prepend.' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], default: 'sonnet' },
        max_tokens: { type: 'number', default: 24000 },
        reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], default: 'high' },
        role: {
          type: 'string',
          description:
            'Optional named role. Swaps in a specialized system prompt for the sub-agent. ' +
            'Built-ins: security-reviewer, perf-analyst, test-writer, api-designer, doc-writer. ' +
            'User overrides: $GOLDUCK_HOME/roles/<name>.md. Unknown names fall back to the generic sub-agent prompt.',
        },
      },
    },
  },
  {
    name: 'rlm_query',
    description:
      'Run a focused sub-query over a scoped text blob. Use when you have a large context and need a focused answer extracted from it.',
    input_schema: {
      type: 'object',
      required: ['context', 'query'],
      properties: {
        context: { type: 'string' },
        query: { type: 'string' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], default: 'sonnet' },
        max_tokens: { type: 'number', default: 12000 },
      },
    },
  },
  {
    name: 'rlm_map',
    description:
      'Apply the same focused query to N independent context slices in parallel. Returns an ordered array of answers.',
    input_schema: {
      type: 'object',
      required: ['contexts', 'query'],
      properties: {
        contexts: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], default: 'sonnet' },
      },
    },
  },
  {
    name: 'rlm_verify',
    description:
      'Panel-critic verifier. Runs {reviewer, adversary} critics in parallel, then a synthesis pass. ' +
      'Returns {verdict: approve|revise, confidence, issues[], suggested_fix}.',
    input_schema: {
      type: 'object',
      required: ['question', 'answer'],
      properties: {
        question: { type: 'string' },
        answer: { type: 'string' },
        model: { type: 'string', enum: ['haiku', 'sonnet', 'opus'], default: 'sonnet' },
      },
    },
  },
  {
    name: 'rlm_propose',
    description:
      'Generate N distinct decomposition strategies for a hard problem. Use before committing to an approach when multiple reasonable paths exist.',
    input_schema: {
      type: 'object',
      required: ['problem'],
      properties: {
        problem: { type: 'string' },
        num_strategies: { type: 'number', default: 3, minimum: 2, maximum: 5 },
      },
    },
  },
  {
    name: 'uncertain_so_recurse',
    description:
      'Given a question + a self-reported uncertainty reason, produce a structured decomposition plan ' +
      '(sub-questions, context slices, integration approach). Returns the plan; caller executes.',
    input_schema: {
      type: 'object',
      required: ['question', 'uncertainty_reason'],
      properties: {
        question: { type: 'string' },
        uncertainty_reason: { type: 'string' },
      },
    },
  },
];

// ────── executors ─────────────────────────────────────────────────────────

const MODEL_MAP = {
  // Policy: Opus 4.7 only. Tags kept for schema back-compat.
  haiku:  'claude-opus-4-7',
  sonnet: 'claude-opus-4-7',
  opus:   'claude-opus-4-7',
};

function modelFor(tag = 'sonnet') { return MODEL_MAP[tag] || tag; }

function guardDepthAndFanout(n = 1) {
  const d = currentDepth();
  const cap = currentFanoutCap();
  if (d >= DEPTH_CAP) throw new Error(`RLM depth cap ${DEPTH_CAP} exceeded (depth=${d})`);
  if (n > cap) throw new Error(`RLM fanout cap ${cap} exceeded (n=${n})`);
}

function thinkingFor(effort) {
  if (!effort || effort === 'low') return null;
  if (effort === 'medium') return { type: 'enabled', budget_tokens: 4096 };
  if (effort === 'high') return { type: 'enabled', budget_tokens: 16384 };
  if (effort === 'xhigh') return { type: 'enabled', budget_tokens: 32768 };
  return null;
}

export async function spawn_agent({ prompt, context = null, model = 'sonnet', max_tokens = 8000, reasoning_effort = 'medium', role = null }) {
  guardDepthAndFanout();
  const GENERIC = 'You are a focused sub-agent spawned by golduck. Answer directly and concisely. No preamble.';
  const roleSystem = role ? resolveRole(role) : null;
  const system = roleSystem || GENERIC;
  const user = context ? `${context}\n\n---\n\n${prompt}` : prompt;
  const nextDepth = currentDepth() + 1;
  return withDepth(nextDepth, async () => {
    const r = await callSub({ system, user, model: modelFor(model), max_tokens, thinking: thinkingFor(reasoning_effort) });
    return { ok: true, text: r.text, usage: r.usage, role: roleSystem ? String(role).toLowerCase() : null };
  });
}

export async function rlm_query({ context, query, model = 'sonnet', max_tokens = 4000, role = null }) {
  return spawn_agent({ prompt: query, context, model, max_tokens, reasoning_effort: 'medium', role });
}

// Re-export so overlays / commands can introspect the registry.
export { listRoles } from './roles.mjs';

export async function rlm_map({ contexts, query, model = 'sonnet' }) {
  guardDepthAndFanout(contexts.length);
  // Bound concurrency to keep from smashing the proxy when contexts is large.
  const conc = currentMapConcurrency();
  const fns = contexts.map((c) => () => rlm_query({ context: c, query, model, max_tokens: 4000 }));
  const results = await _boundedMap(fns, conc);
  return { ok: true, answers: results.map((r) => (r && r.text) || (r && r.error ? `[error: ${r.error}]` : '')) };
}

export async function rlm_verify({ question, answer, model = 'sonnet' }) {
  guardDepthAndFanout(2);
  const critic_sys =
    'You are a careful critic. Read the question, the proposed answer, and any context. ' +
    'Respond with a strict JSON object: { "verdict": "approve" | "revise", ' +
    '"confidence": 0-1, "issues": ["..."], "suggested_fix": "..." }. No prose outside the JSON.';
  const reviewer_user = `# Question\n${question}\n\n# Proposed answer\n${answer}\n\nEvaluate for factual accuracy, completeness, and internal consistency. Emit the JSON verdict.`;
  const adversary_user = `# Question\n${question}\n\n# Proposed answer\n${answer}\n\nPlay devil's advocate. Find the single strongest objection. If none, emit verdict="approve". Emit the JSON verdict.`;
  const nextDepth = currentDepth() + 1;
  return withDepth(nextDepth, async () => {
    const [rev, adv] = await Promise.all([
      callSub({ system: critic_sys, user: reviewer_user, model: modelFor(model), max_tokens: 12000, thinking: { type: 'enabled', budget_tokens: 8000 } }),
      callSub({ system: critic_sys, user: adversary_user, model: modelFor(model), max_tokens: 12000, thinking: { type: 'enabled', budget_tokens: 8000 } }),
    ]);
    const syn_sys = 'You are a neutral synthesizer. Given the reviewer and adversary JSON verdicts, emit a single combined JSON { "verdict", "confidence", "issues", "suggested_fix" } that reflects both. No prose outside.';
    const syn_user = `# Reviewer\n${rev.text}\n\n# Adversary\n${adv.text}\n\nProduce the combined JSON.`;
    const syn = await callSub({ system: syn_sys, user: syn_user, model: modelFor(model), max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 6000 } });
    const parsed = safeJsonParse(syn.text);
    if (parsed && typeof parsed === 'object') return { ok: true, ...parsed };
    return { ok: true, verdict: 'unknown', raw: syn.text };
  });
}

export async function rlm_propose({ problem, num_strategies = 3 }) {
  guardDepthAndFanout(num_strategies);
  const sys = 'You are a distinct strategist. Propose ONE specific strategy. Format: 3-7 sentences, concrete.';
  const nextDepth = currentDepth() + 1;
  return withDepth(nextDepth, async () => {
    const results = await Promise.all(
      Array.from({ length: num_strategies }, (_, i) => callSub({
        system: sys + ` Your distinct angle: #${i+1} of ${num_strategies}. Avoid generic framings.`,
        user: `Problem:\n${problem}\n\nPropose your strategy.`,
        model: modelFor('sonnet'),
        max_tokens: 6000,
        thinking: { type: 'enabled', budget_tokens: 4000 },
      })),
    );
    return { ok: true, strategies: results.map((r, i) => ({ id: i+1, strategy: r.text })) };
  });
}

export async function uncertain_so_recurse({ question, uncertainty_reason }) {
  const sys = 'You are a decomposition planner. Given a question and a reason for uncertainty, return a JSON plan with keys: {sub_questions[], context_slices_needed[], integration_approach, confidence_gate}. No prose outside JSON.';
  const user = `# Question\n${question}\n\n# Why I'm uncertain\n${uncertainty_reason}\n\nProduce the decomposition plan.`;
  const r = await callSub({ system: sys, user, model: modelFor('opus'), max_tokens: 8000, thinking: { type: 'enabled', budget_tokens: 6000 } });
  const parsed = safeJsonParse(r.text);
  if (parsed && typeof parsed === 'object') return { ok: true, ...parsed };
  return { ok: true, plan_text: r.text };
}
