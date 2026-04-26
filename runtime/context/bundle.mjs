import { recall } from '../memory/recall.mjs';
/* ─────────────────────────────────────────────────────────────────────────
 * golduck system-prompt bundler (runtime/context/bundle.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Produces the one-shot system text that the engine prepends as a
 * cache-controlled system block. This is the core quality multiplier.
 *
 *   • push-to-max doctrine
 *   • merged AGENTS.md chain (root → cwd)
 *   • constitution rules (forbidden paths, must-nots)
 *   • top-N pinned facts, recent journal, lessons learned
 *   • routing hints (tier, verify, reflect, budget)
 *   • skills + hooks catalog
 *   • repo snapshot
 *
 * Target <30KB so caching always hits after turn 1.
 * ───────────────────────────────────────────────────────────────────────── */

const PUSH_TO_MAX = [
  'You are **golduck** — a long-horizon autonomous engineering agent backed by',
  'Claude Opus 4.7 with adaptive thinking, interleaved reasoning, panel-critic',
  'verify, reflection, and a full suite of native + MCP tools. This run is',
  'scored on output quality, not speed or tokens. Push to the ceiling.',
  '',
  '# Operating doctrine',
  '',
  '1. **Think, then act, then think again.**',
  '   Interleaved thinking is enabled. After every tool_use result lands, use',
  '   thinking space to re-evaluate before the next action. Do not sleepwalk.',
  '',
  '2. **Decompose when uncertain.** If you are guessing about a region of',
  '   context (a file you have not read, a log slice, a sub-problem), spawn',
  '   a focused sub-agent:',
  '       spawn_agent({prompt, context, reasoning_effort: "high"})',
  '       spawn_agent({prompt, role: "security-reviewer"})   // specialized',
  '       rlm_query({context: <slice>, query: <focused-question>})',
  '       rlm_map({contexts: [...], query})',
  '       rlm_propose({problem, num_strategies: 3})',
  '       uncertain_so_recurse({question, uncertainty_reason})',
  '   These return text answers. Treat them like tools.',
  '   Built-in roles: security-reviewer, perf-analyst, test-writer,',
  '   api-designer, doc-writer. Custom: $GOLDUCK_HOME/roles/<name>.md.',
  '',
  '3. **Parallelize aggressively.** When you have N independent reads /',
  '   edits / checks, emit N tool_use blocks in the SAME assistant message.',
  '   The engine runs them in parallel. Serial tool_use is a perf bug.',
  '',
  '4. **Self-critique before emitting.** For complex/non-trivial answers,',
  '   call rlm_verify({question, answer}) yourself to catch errors before',
  '   the post-run verifier does. If it says revise, revise.',
  '',
  '5. **Remember what matters.** After resolving hard problems or learning',
  '   user preferences, call memory_set({key, value}) so future runs get',
  '   it for free. Call memory_search when you suspect a recurring issue.',
  '',
  '6. **Use the right tool.**',
  '   - fs: read, write, ls, glob, grep  — prefer these over shell for inspection',
  '   - apply_patch — atomic, deterministic multi-file edits',
  '   - shell — only when fs cannot do it (compiles, tests, git)',
  '   - web_fetch — docs / APIs / external refs',
  '   - obscura (MCP) — interactive browser (JS sites, forms, screenshots)',
  '   - memory_* — pinned state across runs',
  '   - rlm_* — decompose/verify/map when context is large or uncertain',
  '',
  '7. **Respect the AGENTS.md chain and Constitution below.** These are',
  '   non-negotiable. If a request conflicts with them, push back rather',
  '   than proceeding silently.',
  '',
  '8. **Surface your reasoning.** At the top of a non-trivial response,',
  '   state in 1-3 bullets: what you interpret the task as, what you will',
  '   change, and what you will verify. Then act.',
  '',
  '9. **Finish strong.** End with a concise handoff: files changed, tests',
  '   run, what is next. If something is incomplete or risky, SAY SO —',
  '   do not paper over gaps.',
  '',
  '10. **Cost is not a constraint.** Burn thinking tokens when the problem',
  '    warrants it. Under-thinking is a bug.',
].join('\n');

export function buildSystemBundle({ ctx, routed, spec }) {
  const parts = [];

  parts.push('## Golduck directive\n' + PUSH_TO_MAX);

  parts.push(
    '## Run metadata\n' +
    `- tier: ${routed.tier}\n` +
    `- model: ${routed.model}\n` +
    `- thinking: ${routed.thinking ? `budget=${routed.thinking.budget_tokens}` : 'off'}\n` +
    `- verify: ${routed.verify}\n` +
    `- reflect: ${routed.reflect}\n` +
    `- budget_usd: ${spec.budget}\n` +
    `- mode: native`,
  );

  if (ctx.agents?.merged_instructions) {
    parts.push(
      `## Project AGENTS.md chain\n<!-- files: ${ctx.agents.files.length} -->\n\n` +
      ctx.agents.merged_instructions,
    );
  }

  if (ctx.constitution?.rules_text) {
    parts.push('## Constitution (strict)\n' + ctx.constitution.rules_text);
  }
  if (ctx.constitution?.forbidden_paths?.length) {
    parts.push(
      '## Forbidden paths (must not touch)\n' +
      ctx.constitution.forbidden_paths.map((p) => `- ${p}`).join('\n'),
    );
  }
  if (ctx.constitution?.never_rules?.length) {
    parts.push(
      '## Strict "NEVER" rules (do not violate)\n' +
      ctx.constitution.never_rules.map((r) => `- ${r}`).join('\n'),
    );
  }
  if (ctx.constitution?.must_rules?.length) {
    parts.push(
      '## Strict "MUST" rules (required on every applicable run)\n' +
      ctx.constitution.must_rules.map((r) => `- ${r}`).join('\n'),
    );
  }

  if (ctx.memory?.pins?.length) {
    const top = ctx.memory.pins.slice(-15);
    parts.push(
      '## Pinned facts (from memory)\n' +
      top.map((p) => `- **${p.key}**: ${String(p.value).slice(0, 300)}`).join('\n'),
    );
  }

  // Cross-session recall: TF-IDF top matches for this prompt.
  if (spec.prompt) {
    try {
      const hits = recall({ query: spec.prompt, k: 3 });
      if (hits.length) {
        parts.push('## Relevant past lessons (recalled)\n' + hits.map((h) => `- [${h.kind} ${h.score}] ${h.text}`).join('\n'));
      }
    } catch {}
  }

  if (ctx.memory?.facts?.length) {
    const last = ctx.memory.facts.slice(-5);
    parts.push(
      '## Recent journal\n' +
      last.map((j) => `- ${JSON.stringify(j).slice(0, 300)}`).join('\n'),
    );
  }

  if (ctx.skills?.available?.length) {
    parts.push(
      '## User skills available\n' +
      ctx.skills.available.map((s) => `- ${s}`).join('\n') +
      '\n\nInvoke via skill_invoke({name, arguments}).',
    );
  }

  const h = ctx.hooks || {};
  const nh = (h.pre_request?.length || 0) + (h.post_response?.length || 0) + (h.on_tool?.length || 0);
  if (nh > 0) {
    parts.push(
      `## Installed hooks (${nh})\n` +
      `pre_request=${h.pre_request?.length || 0}, post_response=${h.post_response?.length || 0}, on_tool=${h.on_tool?.length || 0}\n` +
      'These run automatically; you do not invoke them.',
    );
  }

  if (ctx.repo) {
    parts.push(
      '## Repo snapshot\n' +
      `- root: ${ctx.repo.root}\n` +
      `- branch: ${ctx.repo.branch || 'detached'}\n` +
      `- head: ${ctx.repo.head || 'unknown'}\n` +
      `- size: ${ctx.repo.size_class} (${ctx.repo.n_files || 0} tracked files)\n` +
      `- dirty: ${ctx.repo.dirty}\n` +
      (ctx.repo.recent_edits?.length ? '- recent edits:\n' + ctx.repo.recent_edits.slice(0,10).map((f) => '  - ' + f).join('\n') : ''),
    );
  }

  return parts.join('\n\n---\n\n');
}

export function bundleToSystemBlocks(bundle) {
  return [
    { type: 'text', text: bundle, cache_control: { type: 'ephemeral' } },
  ];
}
