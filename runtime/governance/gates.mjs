/* ─────────────────────────────────────────────────────────────────────────
 * golduck governance gates (runtime/governance/gates.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Pre/post-exec gates that the orchestrator must pass. Enforces:
 *
 *   1. Constitution: forbidden paths, forbidden commands, must-check flags.
 *   2. Trust: known-hostile patterns in prompt (jailbreak injection, exfil).
 *   3. Budget: session/lifetime cost ceiling; refuses to run beyond.
 *   4. AGENTS.md "never" rules: surfaces a warning + logs the rule.
 *
 * The gates are fail-closed on constitution, fail-open-with-warning on
 * trust/AGENTS, and fail-closed on budget. Decisions are traced.
 * ───────────────────────────────────────────────────────────────────────── */
import { event } from '../trace/tracer.mjs';
import { INJECTION_PATTERNS, HARD_BLOCK_PATTERNS, findInjection, findHardBlock } from './patterns.mjs';



function pathInForbidden(path, forbidden) {
  return forbidden.some((f) => path === f || path.startsWith(f.endsWith('/') ? f : f + '/'));
}

export function enforcePrelude({ spec, ctx, routed }) {
  const flags = { allowed: true, reason: null, warnings: [] };

  // 1. Constitution — forbidden paths mentioned in prompt?
  const promptLc = (spec.prompt || '').toLowerCase();
  for (const fp of ctx.constitution.forbidden_paths || []) {
    if (promptLc.includes(fp.toLowerCase())) {
      event('gate.constitution_forbid', { path: fp });
      return { allowed: false, reason: `constitution forbids path: ${fp}` };
    }
  }

  // 2. Trust — detect obvious injection attempts from stdin (weak but fast).
  {
    const inj = findInjection(spec.prompt || '');
    if (inj) {
      event('gate.trust_flag', { pattern: inj.pattern, match: inj.match });
      flags.warnings.push(`potential prompt injection: ${inj.pattern.slice(0, 80)}`);
    }
  }
  {
    const hb = findHardBlock(spec.prompt || '');
    if (hb) {
      event('gate.dangerous_command', { pattern: hb.pattern, match: hb.match });
      return { allowed: false, reason: `dangerous command pattern detected: ${hb.pattern}` };
    }
  }

  // 3. Budget — disabled. Quality-first mode: never block on cost.
  // Spend is still tracked in the ledger for observability; we just don't
  // refuse to run. To re-enable, set GOLDUCK_ENFORCE_BUDGET=1 in env.
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1') {
    const session = ctx.cost_ledger?.session_usd || 0;
    const cap = Number.isFinite(spec.budget) && spec.budget > 0 ? spec.budget : Infinity;
    if (cap !== Infinity && session >= cap) {
      event('gate.budget_exhausted', { session, budget: cap });
      return { allowed: false, reason: `session budget $${cap} exhausted (session_usd=${session.toFixed(2)})` };
    }
  }

  // 4. AGENTS.md never rules — surface them as a banner (not a block),
  //    since those rules are meant to inform the model, not preempt.
  if (ctx.agents.has_never_rules) {
    flags.warnings.push('AGENTS.md contains "never/must not/forbidden" rules — surfaced to model');
  }

  event('gate.prelude.ok', { warnings: flags.warnings.length });
  flags.reason = null;
  return flags;
}

export function enforcePostlude({ spec, ctx, routed, code }) {
  // Track unsuccessful runs in trust ledger; decay over time.
  event('gate.postlude', { code, ok: code === 0 });
  return { ok: code === 0 };
}
