/* ─────────────────────────────────────────────────────────────────────────
 * golduck structured planner (runtime/engine/planner.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Before the engine starts a HARD turn (complex ≥6 OR deep ≥3 OR dirty
 * repo + code score ≥3), we optionally ask Opus to produce a structured
 * plan in one tool-free sub-call:
 *
 *   {
 *     "goal":         "one-sentence restatement of what the user asked",
 *     "subgoals":     ["step 1", "step 2", ...],        // 2-6 concrete items
 *     "risks":        ["risk 1", ...],                  // 0-4 concerns
 *     "checks":       ["how to verify success", ...],   // 0-4 observable probes
 *     "decompose":    "sequential" | "parallel" | "none",
 *     "first_action": "concrete next tool call or message to self"
 *   }
 *
 * The plan is:
 *   (a) stamped into the trace so users can inspect via /trace.
 *   (b) injected as a hidden assistant-side "## Plan" block prepended to
 *       the first model turn's system context — cheap, one-shot.
 *   (c) made available to the best-of-N winner ranker as a scoring anchor
 *       (candidates that *follow* the plan beat candidates that wander).
 *
 * Contract: ALWAYS returns a plan object, even on error (degraded: just goal).
 *           NEVER throws. Latency budget: ~3-6s at 8k thinking budget.
 * ───────────────────────────────────────────────────────────────────────── */

import { streamMessages, buildRequestBody } from './client.mjs';
import { safeJsonParse } from './json_parse.mjs';
import { event } from '../trace/tracer.mjs';
import { resolveModel } from './model_policy.mjs';

const PLANNER_SYS =
  'You are golduck\'s pre-turn planner. Read the user request, the repo snapshot, and any relevant memory. ' +
  'Emit ONLY a strict JSON object with these keys:\n' +
  '{ "goal": string, "subgoals": string[], "risks": string[], "checks": string[], ' +
  '"decompose": "sequential"|"parallel"|"none", "first_action": string }\n' +
  'No prose outside JSON. Keep each field concrete and short. subgoals MUST have 2-6 items. ' +
  'If the task is trivial, return subgoals: ["answer directly"], decompose: "none".';

export function shouldPlan({ routed, spec, ctx }) {
  // Fast-path: never plan trivial or fast-mode runs.
  if (!spec || spec.fast === true) return false;
  if (!routed) return false;
  // Heuristic: plan when the router already decided reflect=deep OR complex/deep score threshold.
  const reflect = routed.reflect;
  if (reflect === 'deep') return true;
  const scores = routed.reasoning?.scores || {};
  if ((scores.complex || 0) >= 6) return true;
  if ((scores.deep || 0) >= 3) return true;
  if (ctx?.repo?.dirty && (scores.code || 0) >= 3) return true;
  return false;
}

function coerce(plan, goalFallback) {
  const p = plan && typeof plan === 'object' ? plan : {};
  const out = {
    goal: typeof p.goal === 'string' ? p.goal.slice(0, 300) : String(goalFallback || '').slice(0, 300),
    subgoals: Array.isArray(p.subgoals) ? p.subgoals.map((x) => String(x).slice(0, 200)).slice(0, 6) : [],
    risks: Array.isArray(p.risks) ? p.risks.map((x) => String(x).slice(0, 200)).slice(0, 4) : [],
    checks: Array.isArray(p.checks) ? p.checks.map((x) => String(x).slice(0, 200)).slice(0, 4) : [],
    decompose: ['sequential', 'parallel', 'none'].includes(p.decompose) ? p.decompose : 'none',
    first_action: typeof p.first_action === 'string' ? p.first_action.slice(0, 300) : '',
  };
  if (!out.subgoals.length) out.subgoals = ['answer directly'];
  return out;
}

/** Render a compact "## Plan" markdown block suitable for prepending to
 *  the system context. Kept <1000 chars so it doesn't bloat the cache. */
export function renderPlan(plan) {
  const lines = [];
  lines.push('## Plan');
  lines.push(`Goal: ${plan.goal}`);
  if (plan.subgoals.length) {
    lines.push('Subgoals:');
    for (const s of plan.subgoals) lines.push(`  - ${s}`);
  }
  if (plan.risks.length) {
    lines.push('Risks to watch:');
    for (const r of plan.risks) lines.push(`  - ${r}`);
  }
  if (plan.checks.length) {
    lines.push('Success checks:');
    for (const c of plan.checks) lines.push(`  - ${c}`);
  }
  lines.push(`Decomposition: ${plan.decompose}`);
  if (plan.first_action) lines.push(`First action: ${plan.first_action}`);
  return lines.join('\n');
}

/**
 * Produces a structured plan for the upcoming turn.
 * Budget-gated: no-op if budgetRemaining < $0.30.
 * Returns { ok, plan, raw } — `plan` always present (may be degraded).
 */
export async function buildPlan({ userIntent, systemSummary, budgetRemaining, thinkingBudget = 8000 }) {
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.3) {
    event('plan.skip', { reason: 'budget_low' });
    return { ok: true, plan: coerce(null, userIntent), raw: null, skipped: 'budget_low' };
  }
  event('plan.start', { chars: String(userIntent || '').length, thinking: thinkingBudget });

  const user =
    '# User request\n' + String(userIntent || '').slice(0, 2500) + '\n\n' +
    (systemSummary ? '# Environment summary\n' + String(systemSummary).slice(0, 2000) + '\n\n' : '') +
    'Emit the JSON plan.';

  try {
    const body = buildRequestBody({
      model: resolveModel(),
      system: [{ type: 'text', text: PLANNER_SYS }],
      messages: [{ role: 'user', content: user }],
      max_tokens: 3500,
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      temperature: 1.0,
    });
    const it = streamMessages(body, { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } });
    let text = '';
    for await (const ev of it) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
    }
    const parsed = safeJsonParse(text);
    const plan = coerce(parsed, userIntent);
    event('plan.done', {
      subgoals: plan.subgoals.length,
      risks: plan.risks.length,
      decompose: plan.decompose,
    });
    return { ok: true, plan, raw: text };
  } catch (e) {
    event('plan.error', { msg: String(e).slice(0, 200) });
    return { ok: false, plan: coerce(null, userIntent), raw: null, error: String(e).slice(0, 200) };
  }
}

// ────── plan self-critique ────────────────────────────────────────────────
// After the initial plan, we run a cheap critic pass that reads the plan +
// user intent and emits { verdict: 'ok' | 'revise', issues: [...], revised_plan? }.
// If verdict='revise', we swap in the revised plan. This catches:
//   - subgoals that don't address the user's actual ask
//   - missing checks / risks for obvious failure modes
//   - "decompose: none" when the task clearly needs parallelism
// Latency cost: ~2-4s additional. Only fires when thinkingBudget >= 6000
// (i.e. hard tasks where one more pass is worth it).

const CRITIC_SYS =
  'You are a plan critic for golduck. Read the user intent and the proposed plan JSON. ' +
  'Judge whether the plan actually addresses the user\'s ask, and whether subgoals / risks / checks are concrete and complete. ' +
  'Emit ONLY a strict JSON object:\n' +
  '{ "verdict": "ok" | "revise", "issues": [string], "revised_plan": { ... } | null }\n' +
  'If verdict="ok", issues MAY be empty and revised_plan MUST be null. ' +
  'If verdict="revise", issues MUST list 1-4 concrete problems and revised_plan MUST be a complete plan object of the same shape as the input.';

/** One round of plan critique. Returns { plan, critiqued: bool, issues }. */
export async function critiquePlan({ userIntent, plan, thinkingBudget = 4000 }) {
  if (!plan) return { plan, critiqued: false, issues: [] };
  try {
    const user =
      '# User intent\n' + String(userIntent || '').slice(0, 2000) + '\n\n' +
      '# Proposed plan\n' + JSON.stringify(plan, null, 2) + '\n\n' +
      'Emit the JSON critique.';
    const body = buildRequestBody({
      model: resolveModel(),
      system: [{ type: 'text', text: CRITIC_SYS }],
      messages: [{ role: 'user', content: user }],
      max_tokens: 3500,
      thinking: { type: 'enabled', budget_tokens: thinkingBudget },
      temperature: 1.0,
    });
    const it = streamMessages(body, { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } });
    let text = '';
    for await (const ev of it) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
    }
    const parsed = safeJsonParse(text);
    if (!parsed || typeof parsed !== 'object') return { plan, critiqued: false, issues: [] };
    const verdict = parsed.verdict === 'revise' ? 'revise' : 'ok';
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x).slice(0, 200)).slice(0, 4) : [];
    if (verdict === 'revise' && parsed.revised_plan && typeof parsed.revised_plan === 'object') {
      const revised = coerce(parsed.revised_plan, userIntent);
      event('plan.critique.revised', { issues: issues.length });
      return { plan: revised, critiqued: true, issues };
    }
    event('plan.critique.ok', {});
    return { plan, critiqued: false, issues: [] };
  } catch (e) {
    event('plan.critique.error', { msg: String(e).slice(0, 200) });
    return { plan, critiqued: false, issues: [] };
  }
}

/**
 * Convenience: buildPlan + optional critique. Only critiques when thinkingBudget
 * is high enough to justify the extra call.
 */
export async function buildPlanWithCritique({ userIntent, systemSummary, budgetRemaining, thinkingBudget = 8000 }) {
  const built = await buildPlan({ userIntent, systemSummary, budgetRemaining, thinkingBudget });
  if (!built.ok || !built.plan) return built;
  if (thinkingBudget < 6000) return built;
  // Budget guard opt-in only.
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.6) {
    return built;
  }
  const crit = await critiquePlan({ userIntent, plan: built.plan, thinkingBudget: Math.min(4000, thinkingBudget / 2) });
  return { ...built, plan: crit.plan, critiqued: crit.critiqued, critiqueIssues: crit.issues };
}
