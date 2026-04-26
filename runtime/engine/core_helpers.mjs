/* ─────────────────────────────────────────────────────────────────────────
 * golduck shared engine helpers (runtime/engine/core_helpers.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Pure helpers that engine.mjs (CLI line-streamer) and tui/engine_tui.mjs
 * (ink store bridge) both need. Extracting these prevents drift between
 * the two ~700 LoC engine loops.
 *
 * Everything here must stay pure (no renderer, no store). Anything that
 * needs to side-effect into a UI belongs back in the adapter.
 * ───────────────────────────────────────────────────────────────────────── */

const PRICING = {
  'claude-opus-4-7': { in: 15, out: 75, cr: 1.5, cw: 18.75 },
};

export function priceFor(model) {
  for (const key of Object.keys(PRICING)) {
    if (String(model).includes(key)) return PRICING[key];
  }
  return PRICING['claude-opus-4-7'];
}

export function usd(usage, model) {
  const p = priceFor(model);
  return (
    (usage?.input_tokens || 0) * p.in +
    (usage?.output_tokens || 0) * p.out +
    (usage?.cache_read_input_tokens || 0) * p.cr +
    (usage?.cache_creation_input_tokens || 0) * p.cw
  ) / 1_000_000;
}

/** Walk back to the most recent plain user message (not tool_result). */
export function extractUserIntent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') return b.text;
        if (typeof b === 'string') return b;
      }
    }
  }
  return '';
}

/** Compact summary-of-tool-result helpers used by both loops. */
export function summarizeResult(r) {
  if (!r) return '';
  if (r.output) return String(r.output).slice(0, 300);
  if (r.content) return String(r.content).slice(0, 300);
  if (r.matches) return `${r.count ?? r.matches.length} matches`;
  if (r.entries) return `${r.entries.length} entries`;
  if (r.pins) return `${r.count ?? r.pins.length} pins`;
  if (r.text) return r.text.slice(0, 300);
  if (r.answers) return `${r.answers.length} answers`;
  if (r.strategies) return `${r.strategies.length} strategies`;
  if (r.body) return String(r.body).slice(0, 300);
  return JSON.stringify(r).slice(0, 300);
}

/** Map a (toolName, error) into a one-line actionable hint for the model. */
export function errorHint(toolName, error) {
  const e = String(error || '').toLowerCase();
  if (e.includes('enoent')) return 'Path not found. Use `ls` or `glob` to discover the right path, then retry.';
  if (e.includes('is_directory')) return 'That path is a directory. Use `ls` instead of `read`.';
  if (e.includes('exists:') && toolName === 'write') return 'File exists. Pass `overwrite: true` if you intended to replace it.';
  if (e.includes('context not found')) return '`apply_patch` could not match the hunk context. Read the file first and copy exact surrounding lines.';
  if (e.includes('parse:')) return 'Patch header/hunk format is off. Re-check the *** Begin Patch / @@ hunk / *** End Patch structure.';
  if (e.includes('rlm depth cap')) return 'RLM recursion cap hit. Answer directly without further spawn_agent calls.';
  if (e.includes('rlm fanout cap')) return 'Fanout cap hit. Split into smaller batches (<=8 parallel sub-agents).';
  if (e.includes('circuit_open')) return 'Upstream proxy is rate-limiting us. Wait a moment and retry with a shorter prompt.';
  if (toolName === 'shell' && e.includes('hard-block')) return 'Command vetoed by safety. Propose a narrower, safer alternative.';
  return null;
}

/** Format a tool result into the content block fed back to the model. */
export function toolResultContent(r, toolName) {
  if (!r) return 'null';
  if (r.ok === false) {
    const hint = errorHint(toolName, r.error);
    return `ERROR: ${r.error || 'unknown'}` + (hint ? `\n\nHint: ${hint}` : '');
  }
  if (r.content) return String(r.content);
  if (r.output) return String(r.output);
  return JSON.stringify(r, null, 2).slice(0, 40_000);
}

/** Shared: the max auto-revise count, honoring the env override. */
export function maxAutoRevisions() {
  const n = parseInt(process.env.GOLDUCK_MAX_AUTO_REVISIONS || '2', 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** Shared: run-level safety budget (USD). `0` or negative disables. */
export function safetyBudgetUsd(spec) {
  const override = parseFloat(process.env.GOLDUCK_SAFETY_BUDGET_USD || 'NaN');
  const fromSpec = spec && Number.isFinite(spec.safetyBudget) ? spec.safetyBudget : NaN;
  const v = Number.isFinite(override) ? override : (Number.isFinite(fromSpec) ? fromSpec : 10);
  return v;
}

/** Extract touched paths from an apply_patch patch text (header-anchored). */
export function filesFromPatch(patchText) {
  const s = String(patchText || '');
  const out = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m;
  while ((m = re.exec(s))) out.push(m[1].trim());
  return out;
}

/** Build the synthetic user message that revert-rollback uses to re-anchor
 *  the last assistant text on a prior answer (used when rerunVerify rolls
 *  back). Returns { didPatch: boolean }. */
export function mirrorPriorAnswer(messages, priorAnswer) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      m.content = priorAnswer;
      return { didPatch: true };
    }
    if (Array.isArray(m.content)) {
      const idx = m.content.findIndex((b) => b.type === 'text');
      if (idx >= 0) {
        m.content[idx] = { ...m.content[idx], text: priorAnswer };
        return { didPatch: true };
      }
    }
  }
  return { didPatch: false };
}
