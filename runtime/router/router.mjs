/* ─────────────────────────────────────────────────────────────────────────
 * golduck router (runtime/router/router.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Policy: Opus 4.7 everywhere. No cost tiering.
 *
 * We still score the prompt — but only to decide THINKING BUDGET,
 * MAX_TOKENS, VERIFY, REFLECT, PERSONAS. Never model.
 *
 * Rationale: cost is not a constraint. Quality is. Opus 4.7 + deep
 * thinking + verify + reflect wins on every workload.
 * ───────────────────────────────────────────────────────────────────────── */

const MODEL = 'claude-opus-4-7';

const COMPLEX_HINTS = [
  'explain why', 'design', 'architect', 'refactor', 'root cause', 'trade-off',
  'tradeoff', 'analyze', 'analyse', 'compare and contrast', 'pros and cons',
  'threat model', 'security audit', 'debug', 'performance', 'prove', 'derive',
  'benchmark', 'reason about', 'optimise', 'optimize', 'concurrency', 'race',
  'deadlock', 'distributed', 'consensus', 'proof', 'invariant',
];
const DEEP_HINTS = [
  'step by step', 'detailed walkthrough', 'deep dive', 'full analysis',
  'comprehensive', 'exhaustive', 'review every', 'audit every', 'every file',
  'whole codebase', 'entire repo',
];
const CODE_HINTS = [
  'implement', 'patch', 'apply_patch', 'diff', 'commit', 'refactor this',
  'add a test', 'write a function', 'fix the', 'introduce', 'wire up',
];

function score(prompt, ctx) {
  const s = String(prompt || '').toLowerCase();
  const len = s.length;
  let complex = 0, deep = 0, code = 0;
  for (const h of COMPLEX_HINTS) if (s.includes(h)) complex += 2;
  for (const h of DEEP_HINTS)    if (s.includes(h)) deep += 3;
  for (const h of CODE_HINTS)    if (s.includes(h)) code += 2;
  const codeBlocks = (s.match(/```/g) || []).length / 2;
  const questions = (s.match(/\?/g) || []).length;
  if (codeBlocks >= 1) { complex += 2; code += 1; }
  if (questions >= 3) complex += 1;
  if (len > 4000)  complex += 3;
  if (len > 12000) deep += 2;
  if (ctx?.repo?.dirty) code += 2;
  const sz = ctx?.repo?.size_class;
  if (sz === 'large') complex += 2;
  if (sz === 'huge')  deep += 2;
  if (ctx?.agents?.has_never_rules) complex += 1;
  return { complex, deep, code, len };
}

export function route({ prompt, spec, ctx }) {
  const sc = score(prompt, ctx);

  // Opus 4.7, always.
  const model = spec.model || MODEL;

  // Thinking budget: scales with complexity. Always on for this framework.
  // Opus 4.7 supports up to 64k thinking tokens; we pick based on signals.
  let thinking_budget;
  if (sc.deep >= 3 || sc.complex >= 6 || sc.len > 8000)        thinking_budget = 48000;
  else if (sc.complex >= 3 || sc.code >= 3)                    thinking_budget = 32000;
  else if (sc.complex > 0 || sc.code > 0)                      thinking_budget = 16000;
  else                                                          thinking_budget = 8000;
  const thinking = { type: 'enabled', budget_tokens: thinking_budget };

  // Max output tokens: tied to thinking budget + response headroom.
  // Bedrock Opus 4.7 hard-caps max_tokens at 128000. Headroom of 16000
  // for final response tokens. Clamp both sides.
  const THINK_CAP = 100000;
  const MAX_CAP = 128000;
  const clamped_think = Math.min(thinking_budget, THINK_CAP);
  const max_tokens = Math.min(clamped_think + 16000, MAX_CAP);
  thinking.budget_tokens = Math.min(clamped_think, max_tokens - 4096);

  // Verify decision.
  let verify = spec.verify;
  if (verify === 'auto') {
    verify = (sc.complex >= 3 || sc.deep >= 2 || (ctx?.repo?.dirty && sc.code > 0)) ? 'on' : 'off';
  }

  // Reflect decision.
  let reflect = spec.reflect;
  if (reflect === 'auto') {
    reflect = sc.deep >= 2 ? 'deep' : (sc.complex >= 4 ? 'shallow' : 'off');
  }

  // Personas for the verifier panel.
  const persona = spec.persona
    ? spec.persona.split(',').map((x) => x.trim()).filter(Boolean)
    : ['reviewer', 'adversary', 'planner'];

  // Fanout cap for parallel sub-agents (RLM depth 0 spawns).
  const fanout_cap = 12;

  return {
    model,
    tier: 'opus',
    thinking,
    max_tokens,
    verify,
    reflect,
    persona,
    fanout_cap,
    reasoning: {
      scores: sc,
      chose_tier: 'opus',
      chose_model: model,
      chose_thinking: `budget=${thinking_budget}`,
      chose_max_tokens: max_tokens,
      chose_verify: verify,
      chose_reflect: reflect,
      persona,
    },
  };
}
