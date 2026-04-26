/* ─────────────────────────────────────────────────────────────────────────
 * golduck panel-verify (runtime/engine/panel_verify.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Parallel sibling to auto_verify.mjs that runs a *roster* of persona
 * verifiers over a final answer and produces a per-persona verdict list
 * plus a consensus.
 *
 * Data source: ~/.golduck/state/personas.json
 *   { "active": ["name", ...], "all": [{name, prompt?, description?}, ...] }
 *
 * Each active persona's `prompt` is used as the verifier system prompt
 * (fallback: the reviewer+adversary+planner trio from personas_library).
 * Each persona makes one /v1/messages call via buildRequestBody +
 * streamMessages, exactly the way auto_verify / rlm_verify drive the client.
 *
 * Contract: this module never throws. On any error it returns
 *   { kind: 'skip', panel: [], consensus: { verdict: 'skip', confidence: 0 } }
 * and swallows the failure with a tracer event.
 *
 * auto_verify wiring is intentionally NOT done here — that belongs to
 * whoever owns engine.mjs.
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildRequestBody, streamMessages } from './client.mjs';
import { parseVerdict as parseVerdictShared } from './json_parse.mjs';
import { event } from '../trace/tracer.mjs';
import { resolvePersona, defaultTrio } from './personas_library.mjs';
import { resolveModel } from './model_policy.mjs';

const PANEL_CAP = 3;
const BUDGET_FLOOR = 0.5;
// Verifier model resolves to the current override (env GOLDUCK_MODEL) / default.

const VERDICT_SYS_SUFFIX =
  '\n\nRespond with a STRICT JSON object and nothing else:\n' +
  '{ "verdict": "approve" | "revise", "confidence": 0.0-1.0, "issues": ["..."] }\n' +
  'No prose, no markdown fences. `issues` may be an empty array when verdict="approve".';

function loadPersonas() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const file = join(HOME, 'state', 'personas.json');
  if (!existsSync(file)) return { active: defaultTrio(), source: 'library_default' };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const all = Array.isArray(parsed?.all)
      ? parsed.all.filter((p) => p && typeof p.name === 'string')
      : [];
    const activeNames = Array.isArray(parsed?.active)
      ? parsed.active.map(String).filter(Boolean)
      : [];
    const resolved = [];
    for (const name of activeNames) {
      const meta = all.find((p) => p.name === name) || { name };
      resolved.push({
        name: meta.name,
        prompt: typeof meta.prompt === 'string' && meta.prompt.trim() ? meta.prompt : null,
        description: meta.description || '',
      });
    }
    if (!resolved.length) return { active: defaultTrio(), source: 'library_default_empty_active' };
    return { active: resolved, source: 'file' };
  } catch (e) {
    event('panel_verify.personas_parse_error', { msg: String(e) });
    return { active: defaultTrio(), source: 'library_default_parse_error' };
  }
}

function personaSystemPrompt(p) {
  const base = (p.prompt && p.prompt.trim())
    ? p.prompt.trim()
    : `You are the "${p.name}" verifier. Evaluate the proposed answer rigorously from your persona's perspective.`;
  return base + VERDICT_SYS_SUFFIX;
}

function buildUserBlock({ userIntent, finalText, routed }) {
  const routedLine = routed
    ? `# Routing\nmodel=${routed.model || 'unknown'}; effort=${routed.effort || 'unknown'}\n\n`
    : '';
  return (
    '# Question\n' +
    String(userIntent || '').slice(0, 2000) +
    '\n\n' +
    routedLine +
    '# Proposed answer\n' +
    String(finalText || '').slice(0, 20000) +
    '\n\nEmit the JSON verdict now.'
  );
}

function parseVerdict(raw) {
  const v = parseVerdictShared(raw);
  // panel_verify historically returns only these three keys — drop suggested_fix for back-compat.
  return { verdict: v.verdict, confidence: v.confidence, issues: v.issues };
}

async function callPersona({ persona, userIntent, finalText, routed }) {
  const system = personaSystemPrompt(persona);
  const user = buildUserBlock({ userIntent, finalText, routed });
  // Thinking budget: honor explicit /think override, else default 4000.
  const thinkBudget = parseInt(process.env.GOLDUCK_PANEL_THINK || process.env.GOLDUCK_THINKING_BUDGET || '4000', 10);
  const body = buildRequestBody({
    model: resolveModel(),
    system,
    messages: [{ role: 'user', content: user }],
    max_tokens: Math.max(2000, thinkBudget),
    thinking: thinkBudget > 0 ? { type: 'enabled', budget_tokens: thinkBudget } : null,
    temperature: 1.0,
  });
  let text = '';
  try {
    const it = streamMessages(body);
    for await (const ev of it) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text || '';
      }
    }
  } catch (e) {
    event('panel_verify.persona_error', { name: persona.name, msg: String(e) });
    return { name: persona.name, verdict: 'skip', confidence: 0, issues: [] };
  }
  const parsed = parseVerdict(text);
  return { name: persona.name, verdict: parsed.verdict, confidence: parsed.confidence, issues: parsed.issues };
}

function computeConsensus(panel) {
  const scored = panel.filter((p) => p.verdict === 'approve' || p.verdict === 'revise');
  if (!scored.length) return { verdict: 'skip', confidence: 0 };
  const anyRevise = scored.some((p) => p.verdict === 'revise');
  const avg = scored.reduce((acc, p) => acc + (Number(p.confidence) || 0), 0) / scored.length;
  return {
    verdict: anyRevise ? 'revise' : 'approve',
    confidence: Math.round(avg * 1000) / 1000,
  };
}

/**
 * Resolve the persona roster for this run. Priority:
 *   1. `routed.persona` — the router/CLI-supplied list; if any entries match
 *      personas in ~/.golduck/state/personas.json we use the rich prompt from
 *      file, otherwise we synthesize a generic persona prompt from the name.
 *   2. `personas.json` active list — if no routed override is given.
 *   3. `personas_library.defaultTrio()` fallback when the file is missing
 *      or empty; individual unknown names resolve through `resolvePersona`
 *      before falling back to a synthesized generic prompt.
 * Always returns { active, source }.
 */
function resolveRoster(routed) {
  const requested = Array.isArray(routed?.persona) ? routed.persona.filter(Boolean) : [];
  const file = loadPersonas();
  if (!requested.length) return file;
  const fileAll = Array.isArray(file.active) ? file.active : [];
  const resolved = requested.map((name) => {
    const hit = fileAll.find((p) => p && p.name === name);
    if (hit) return hit;
    const fromLib = resolvePersona(name);
    if (fromLib) return fromLib;
    return {
      name,
      prompt: `You are the "${name}" verifier. Evaluate the proposed answer rigorously from this persona's perspective.`,
      description: 'synthesized-from-routed',
    };
  });
  return { active: resolved, source: 'routed+' + file.source };
}

export async function panelVerify({ userIntent, finalText, routed, budgetRemaining } = {}) {
  try {
    if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
        budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < BUDGET_FLOOR) {
      event('panel_verify.skip', { reason: 'budget_low', budgetRemaining });
      return { kind: 'skip', panel: [], consensus: { verdict: 'skip', confidence: 0 } };
    }
    if (!finalText || !String(finalText).trim()) {
      event('panel_verify.skip', { reason: 'empty_final_text' });
      return { kind: 'skip', panel: [], consensus: { verdict: 'skip', confidence: 0 } };
    }

    const { active, source } = resolveRoster(routed);
    const roster = active.slice(0, Math.min(PANEL_CAP, active.length));
    if (!roster.length) {
      event('panel_verify.skip', { reason: 'no_personas', source });
      return { kind: 'skip', panel: [], consensus: { verdict: 'skip', confidence: 0 } };
    }

    event('panel_verify.start', {
      personas: roster.map((p) => p.name),
      source,
      chars: String(finalText).length,
    });

    // Parallel per-persona calls. Each persona is a ~4k thinking-budget critic;
    // running them in parallel cuts the panel wallclock from N*T to ~T without
    // materially increasing proxy pressure (we've already budget-gated this
    // block above).
    const panel = await Promise.all(roster.map(
      (persona) => callPersona({ persona, userIntent, finalText, routed }),
    ));

    const consensus = computeConsensus(panel);
    event('panel_verify.consensus', { verdict: consensus.verdict, confidence: consensus.confidence });

    const kind = consensus.verdict === 'approve'
      ? 'approve'
      : consensus.verdict === 'revise'
        ? 'revise'
        : 'skip';
    return { kind, panel, consensus };
  } catch (e) {
    event('panel_verify.error', { msg: String(e) });
    return { kind: 'skip', panel: [], consensus: { verdict: 'skip', confidence: 0 } };
  }
}
