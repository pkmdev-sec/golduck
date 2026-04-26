/* ═════════════════════════════════════════════════════════════════════════
 * golduck native engine (runtime/engine/engine.mjs)
 * ═════════════════════════════════════════════════════════════════════════
 * Core conversation loop. Speaks the Anthropic /v1/messages API natively
 * with streaming, interleaved thinking, and parallel tool_use.
 *
 * Invariants:
 *   • The model ALWAYS sees the canonical message shape (user → assistant → user …).
 *   • Slash commands live in a single handler (handleSlashCommand).
 *   • The interactive prompt happens in exactly one place per iteration.
 *   • Ctrl+C once = finish current turn then save; twice = force exit.
 *   • Every agentic turn wraps the API call in withRetry + runs pre/post
 *     hooks exactly once.
 * ───────────────────────────────────────────────────────────────────────── */

import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { streamMessages, buildRequestBody } from './client.mjs';
import { buildRegistry } from './registry.mjs';
import { maybeCompact, estimateTokens } from './compact.mjs';
import { summarizeIfHuge } from './tool_summarize.mjs';
import { safetyCheck } from './safety.mjs';
import { withRetry } from './retry.mjs';
import { runPreRequest, runPostResponse, runOnTool } from './hooks.mjs';
import { autoVerify, rerunVerify } from './auto_verify.mjs';
import { validateAfter as syntaxValidateAfter } from './syntax_check.mjs';
import { validateToolInput } from './input_validate.mjs';
import { gitDirtyWarning } from './git_check.mjs';
import { computeHandoff, renderHandoff } from './handoff.mjs';
import { event, span } from '../trace/tracer.mjs';
import {
  renderBanner, renderUser, renderAssistantStart, renderAssistantText,
  renderThinking, renderToolUseStart, renderToolDone, renderUsage, C,
} from '../ui/render.mjs';
import { findInjection } from '../governance/patterns.mjs';
import { panelVerify } from './panel_verify.mjs';
import { maybeBestOfN, adaptiveSamples } from './best_of_n.mjs';
import { runVerifyPipeline } from './verify_pipeline.mjs';
import { buildPlan, buildPlanWithCritique, critiquePlan, renderPlan, shouldPlan } from './planner.mjs';
import { buildRefresh, memoryMtimes } from '../memory/refresh.mjs';
import { maybeAutoLesson } from '../memory/lessons.mjs';
import { scheduleFactExtract } from '../memory/fact_extract.mjs';
import { cacheKey, getCached, setCached, invalidateAll, invalidateByPrefix, pathsForTool } from './tool_cache.mjs';
import { validateToolResult } from './output_validate.mjs';
import { dispatchToolCalls as _sharedDispatchToolCalls } from './turn.mjs';
import { snapshotBeforePatch as _snapBeforePatch, snapshotBeforeWrite as _snapBeforeWrite } from '../tui/patch_snapshot.mjs';

// Shared helpers (usd, summarizeResult, errorHint, toolResultContent,
// extractUserIntent) live in core_helpers.mjs so the CLI and TUI use the
// same implementations.
import { usd, summarizeResult, errorHint, toolResultContent, extractUserIntent } from './core_helpers.mjs';

// Parallel-tool cap — guards against the model emitting 30+ tool_use blocks
// at once, which would overwhelm the local machine.
const TOOL_CONCURRENCY = parseInt(process.env.GOLDUCK_TOOL_CONCURRENCY || '6', 10);

// Thin wrapper kept for call-site API stability; delegates to the shared
// governance/patterns catalog so every layer uses the same rules.
function detectInjection(content) {
  const f = findInjection(typeof content === 'string' ? content : '');
  return f ? f.pattern : null;
}

// ────── one turn ───────────────────────────────────────────────────────────

async function oneTurn({ model, system, messages, tools, thinking, max_tokens, renderer }) {
  const body = buildRequestBody({ model, system, messages, tools, thinking, max_tokens });
  event('engine.request', { model, tool_count: tools.length, msg_count: messages.length, thinking: Boolean(thinking), max_tokens });

  const iter = await withRetry('messages', () => streamMessages(body, {
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  }));

  const currentBlocks = [];
  let currentText = '';
  let currentThinking = '';
  let stopReason = null;
  let usage = {};
  let assistantStarted = false;

  for await (const ev of iter) {
    if (ev.type === 'message_start') {
      usage = { ...usage, ...(ev.message?.usage || {}) };
    } else if (ev.type === 'content_block_start') {
      const blk = { ...ev.content_block };
      currentBlocks[ev.index] = blk;
      if (blk.type === 'text' && !assistantStarted) {
        renderer.line(renderAssistantStart());
        assistantStarted = true;
      } else if (blk.type === 'tool_use') {
        blk.inputStr = '';
      }
    } else if (ev.type === 'content_block_delta') {
      const blk = currentBlocks[ev.index] || {};
      const d = ev.delta;
      if (d?.type === 'text_delta') {
        blk.text = (blk.text || '') + d.text;
        currentText += d.text;
        renderer.raw(renderAssistantText(d.text));
      } else if (d?.type === 'thinking_delta') {
        blk.thinking = (blk.thinking || '') + d.thinking;
        currentThinking += d.thinking;
        // rendered compact on content_block_stop
      } else if (d?.type === 'input_json_delta') {
        blk.inputStr = (blk.inputStr || '') + (d.partial_json || '');
      } else if (d?.type === 'signature_delta') {
        blk.signature = d.signature;
      }
      currentBlocks[ev.index] = blk;
    } else if (ev.type === 'content_block_stop') {
      const blk = currentBlocks[ev.index];
      if (blk?.type === 'thinking' && blk.thinking) {
        const lines = blk.thinking.split('\n').length;
        const chars = blk.thinking.length;
        const preview = blk.thinking.replace(/\s+/g, ' ').slice(0, 80);
        renderer.line(C.dim('◇ thought ') + C.dim(`(${lines}L / ${chars}c)`) + C.dim(' · ' + preview + (chars > 80 ? '…' : '')));
        event('engine.thinking', { lines, chars, preview: blk.thinking.slice(0, 4000) });
      }
      if (blk?.type === 'tool_use') {
        if (blk.inputStr) {
          try { blk.input = JSON.parse(blk.inputStr); }
          catch { blk.input = { _raw: blk.inputStr, _error: 'invalid_json' }; }
        }
        const preview = blk.input ? JSON.stringify(blk.input).slice(0, 160) : `(${blk.name})`;
        renderer.line(renderToolUseStart({ name: blk.name, inputPreview: preview }));
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      usage = { ...usage, ...(ev.usage || {}) };
    } else if (ev.type === 'message_stop') {
      break;
    } else if (ev.type === 'error') {
      throw new Error(`API error: ${JSON.stringify(ev.error || ev).slice(0, 400)}`);
    }
  }

  renderer.line(''); // newline after the stream

  const assistantContent = currentBlocks.filter(Boolean).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text || '' };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking || '', signature: b.signature };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    return null;
  }).filter(Boolean);

  event('engine.response', { stop_reason: stopReason, usage, model });
  const est = estimateTokens(messages, system);
  const ctx_pct = Math.round((est / 1_000_000) * 1000) / 10;
  renderer.line(renderUsage({
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    usd: usd(usage, model),
    ctx_pct,
  }));

  return { assistantContent, stopReason, usage, text: currentText, thinking: currentThinking };
}

// ────── tool calls (parallel, bounded) ─────────────────────────────────────

async function runToolCalls({ toolUses, registry, renderer, userIntent, toolSchemas, gitWarnedPaths }) {
  // Thin CLI adapter around the shared turn.mjs dispatch pipeline. The
  // renderer wiring is the only CLI-specific piece; everything else —
  // schema check, cache, safety, hooks, undo snapshot, git warn, injection
  // sniff, syntax check — lives in turn.mjs so the TUI path shares it.
  const observer = {
    onToolUseStart: (e) => renderer.line(renderToolUseStart({ name: e.name, inputPreview: e.inputPreview })),
    onToolDone: (e) => renderer.line(renderToolDone({ name: e.name, ok: e.ok, summary: e.summary, duration_ms: e.duration_ms })),
  };
  return _sharedDispatchToolCalls({
    toolUses, registry, userIntent, toolSchemas, gitWarnedPaths,
    snapshotBeforePatch: _snapBeforePatch,
    snapshotBeforeWrite: _snapBeforeWrite,
    observer, concurrency: TOOL_CONCURRENCY,
  });
}

// summarizeResult / errorHint / toolResultContent now come from core_helpers.mjs.
function makeRenderer() {
  return {
    line(s) { if (s != null && s !== '') process.stdout.write(s + '\n'); },
    raw(s)  { if (s != null) process.stdout.write(s); },
  };
}

export function saveSession({ home, sessionId, messages, model, systemBundle }) {
  try {
    const dir = join(home, 'state', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify({
      updated_at: new Date().toISOString(),
      model, systemBundle: systemBundle.slice(0, 30_000),
      messages,
    }, null, 2));
  } catch {}
}
export function loadSession({ home, sessionId }) {
  const f = join(home, 'state', 'sessions', `${sessionId}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function prompt(rl, label) {
  return new Promise((resolve) => rl.question(label, (l) => resolve(l)));
}

// ────── slash commands ────────────────────────────────────────────────────

async function handleSlashCommand({ line, state, renderer, ctx }) {
  const { routed, spec, home, sessionId, systemBundle, traceFile, toolSchemas, systemBlocks } = ctx;
  const L = line.trim();

  switch (L) {
    case '/help':
      renderer.line(C.dim('commands: /help /exit /quit /reset /save /stats /tokens /cost /tools /compact /trace /read <path>'));
      return { handled: true };
    case '/exit': case '/quit':
      return { handled: true, exit: true };
    case '/reset':
      state.messages.length = 0;
      renderer.line(C.dim('reset — conversation cleared'));
      return { handled: true };
    case '/stats':
      renderer.line(C.dim(`turns=${state.turns} $=${state.usdTotal.toFixed(4)} messages=${state.messages.length}`));
      return { handled: true };
    case '/tokens':
      renderer.line(C.dim(`est_tokens=${estimateTokens(state.messages, systemBlocks)} (soft=700k, hard=900k)`));
      return { handled: true };
    case '/cost':
      renderer.line(C.dim(`usd_session=$${state.usdTotal.toFixed(4)} budget=$${spec.budget}`));
      return { handled: true };
    case '/tools':
      renderer.line(C.dim(`${toolSchemas.length} tools available`));
      for (const t of toolSchemas) renderer.line(C.dim('  · ' + t.name));
      return { handled: true };
    case '/compact': {
      const c = await maybeCompact({ messages: state.messages, system: systemBlocks, model: routed.model });
      if (c.compacted) {
        state.messages = c.messages;
        renderer.line(C.dim(`compacted → ${state.messages.length} messages`));
      } else {
        renderer.line(C.dim(`no compaction needed (est=${c.est})`));
      }
      return { handled: true };
    }
    case '/trace':
      renderer.line(C.dim('trace: ' + traceFile));
      return { handled: true };
    case '/save':
      saveSession({ home, sessionId, messages: state.messages, model: routed.model, systemBundle });
      renderer.line(C.dim('saved → ' + sessionId));
      return { handled: true };
    default:
      if (L.startsWith('/read ')) {
        const path = L.slice(6).trim();
        try {
          const content = readFileSync(path, 'utf8').slice(0, 200_000);
          state.pendingContext.push({ path, content });
          renderer.line(C.dim(`loaded ${path} (${content.length} bytes); will be prepended to your next message`));
          return { handled: true };
        } catch (e) {
          renderer.line(C.red(`/read error: ${e.message}`));
          return { handled: true };
        }
      }
      return { handled: false };
  }
}

// ────── main ───────────────────────────────────────────────────────────────

export async function runEngine({ runId, sessionId, home, traceFile, spec, ctx, routed, systemBundle }) {
  const registry = await buildRegistry();
  process.env.GOLDUCK_RUN_ID = runId;
  if (routed?.fanout_cap) process.env.GOLDUCK_FANOUT_CAP = String(routed.fanout_cap);

  // Graceful SIGINT: finish current turn, save, exit. Double Ctrl+C = force.
  let interrupted = 0;
  const onSig = () => {
    interrupted++;
    if (interrupted === 1) {
      console.error('\n\x1b[33m[golduck] interrupt received; finishing turn then saving...\x1b[0m');
    } else {
      console.error('\x1b[31m[golduck] second interrupt; force-exiting\x1b[0m');
      try { registry.shutdown(); } catch {}
      process.exit(130);
    }
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  const toolSchemas = registry.tools;
  let systemBlocks = [
    { type: 'text', text: systemBundle, cache_control: { type: 'ephemeral' } },
  ];

  const renderer = makeRenderer();
  renderer.line(renderBanner({
    runId,
    model: routed.model,
    tier: routed.tier,
    thinking: routed.thinking,
    verify: routed.verify,
    reflect: routed.reflect,
    budget: spec.budget,
    home,
    bundleBytes: systemBundle.length,
    toolCount: toolSchemas.length,
    mcpServers: Object.keys(registry.mcpServers).length,
  }));

  // Resume prior session if asked.
  const state = { messages: [], turns: 0, usdTotal: 0, finalAnswer: '', hadToolRounds: false, autoRevisions: 0, autoRevised: false, gitWarnedPaths: new Set(), lastVerify: null, pendingContext: [], priorVerdict: null, priorAnswer: null };
  if (spec.resume) {
    const prior = loadSession({ home, sessionId });
    if (prior) {
      state.messages = prior.messages;
      renderer.line(C.dim(`[resumed ${state.messages.length} messages]`));
    }
  }

  // If a one-shot prompt was given, seed it.
  if (spec.prompt) {
    renderer.line(renderUser(spec.prompt));
    state.messages.push({ role: 'user', content: spec.prompt });
  }

  const rl = spec.interactive
    ? createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    : null;

  const slashCtx = { routed, spec, home, sessionId, systemBundle, traceFile, toolSchemas, systemBlocks };
  // `state` is passed in separately to handleSlashCommand so commands can mutate it.

  try {
    while (true) {
      if (interrupted) break;

      // If we need a new user message and nothing is queued, prompt (interactive only).
      const lastMsg = state.messages[state.messages.length - 1];
      const needsUser = !lastMsg || lastMsg.role === 'assistant';
      if (needsUser) {
        if (!rl) break; // one-shot, done
        const line = await prompt(rl, C.mag('▸ '));
        if (!line) continue;
        if (line.startsWith('/')) {
          const r = await handleSlashCommand({ line, state, renderer, ctx: slashCtx });
          if (r.exit) break;
          if (r.handled) continue;
        }
        // Prepend any pending /read context to this turn.
        let userContent = line;
        if (state.pendingContext.length) {
          const ctx_blocks = state.pendingContext.map((c) => `<file path="${c.path}">\n${c.content}\n</file>`).join('\n\n');
          userContent = `${ctx_blocks}\n\n---\n\n${line}`;
          state.pendingContext.length = 0;
        }
        state.messages.push({ role: 'user', content: userContent });
      }

      state.turns++;
      if (state.turns > spec.max_turns) {
        renderer.line(C.ylw(`[max_turns=${spec.max_turns} reached]`));
        break;
      }

      // pre_request hook (can mutate messages).
      try {
        const hr = await runPreRequest({ messages: state.messages, systemBytes: systemBundle.length, model: routed.model });
        if (hr.messages && hr.messages !== state.messages) state.messages = hr.messages;
      } catch (e) { event('hook.pre_request.error', { msg: String(e) }); }

      // Structured pre-turn planner. Fires once per fresh user turn when
      // the router says the task is hard. Injects a compact '## Plan' block
      // into the system context so the model sees its own plan before acting.
      try {
        const freshUserTurn = !state.lastPlannedFor || state.lastPlannedFor !== state.messages.length;
        if (freshUserTurn && shouldPlan({ routed, spec, ctx })) {
          const userIntent = extractUserIntent(state.messages);
          const pr = await buildPlanWithCritique({
            userIntent,
            budgetRemaining: spec.budget - state.usdTotal,
            thinkingBudget: Math.min(8000, (routed.thinking?.budget_tokens || 8000) / 2),
          });
          if (pr && pr.plan) {
            state.currentPlan = pr.plan;
            state.lastPlannedFor = state.messages.length;
            const planBlock = { type: 'text', text: renderPlan(pr.plan), cache_control: { type: 'ephemeral' } };
            // Prepend the plan so the original bundle stays cacheable.
            // systemBlocks is the per-turn array the engine hands to client.
            systemBlocks = [planBlock, ...systemBlocks.filter((b) => b && !b._isPlan)];
            planBlock._isPlan = true;
            renderer.line(C.dim(`[plan: ${pr.plan.subgoals.length} subgoals · ${pr.plan.decompose}${pr.critiqued ? ' · critiqued' : ''}]`));
            if (pr.critiqued && Array.isArray(pr.critiqueIssues) && pr.critiqueIssues.length) {
              event('plan.critique_issues', { count: pr.critiqueIssues.length });
            }
          }
        }
      } catch (e) { event('plan.fatal', { msg: String(e) }); }

      // Mid-run memory refresh: prepends a tiny '## Memory refresh' block
      // scoped to the current user turn only (so the big cached bundle stays
      // unchanged). Includes top-3 recall hits + newly-learned facts/lessons.
      try {
        if (state.lastPlannedFor === state.messages.length) {
          const userText = extractUserIntent(state.messages);
          const refresh = buildRefresh({ userText, sinceMs: state.lastRefreshMs || 0 });
          if (refresh) {
            const refreshBlock = { type: 'text', text: refresh, cache_control: { type: 'ephemeral' }, _isRefresh: true };
            systemBlocks = [
              ...systemBlocks.filter((b) => b && !b._isRefresh),
              refreshBlock,
            ];
            const mt = memoryMtimes();
            state.lastRefreshMs = Math.max(mt.facts, mt.lessons, mt.journal, Date.now());
            event('memory.refresh_applied', { chars: refresh.length });
          }
        }
      } catch (e) { event('memory.refresh_error', { msg: String(e) }); }

      // Compact if approaching window.
      try {
        const c = await maybeCompact({ messages: state.messages, system: systemBlocks, model: routed.model });
        if (c.compacted) {
          state.messages = c.messages;
          renderer.line(C.dim(`[compacted; est_tokens=${c.est}]`));
        }
      } catch (e) { event('compact.error', { msg: String(e) }); }

      // Model call.
      const { assistantContent, stopReason, usage, text } = await oneTurn({
        model: routed.model, system: systemBlocks, messages: state.messages,
        tools: toolSchemas, thinking: routed.thinking,
        max_tokens: routed.max_tokens, renderer,
      });
      state.usdTotal += usd(usage, routed.model);
      state.messages.push({ role: 'assistant', content: assistantContent });
      state.finalAnswer = text;
      // Run-level safety budget (always on unless 0/disabled).
      const sb = Number.isFinite(spec.safetyBudget) ? spec.safetyBudget : 10;
      if (sb > 0 && state.usdTotal >= sb) {
        renderer.line(C.red(`[safety-budget ${sb} reached (usd=${state.usdTotal.toFixed(4)}); aborting run]`));
        event('engine.safety_budget_breach', { usd: state.usdTotal, safety_budget: sb });
        break;
      }
      if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
          Number.isFinite(spec.budget) && spec.budget > 0 &&
          state.usdTotal >= spec.budget) {
        renderer.line(C.ylw(`[budget ceiling ${spec.budget} reached mid-turn (usd=${state.usdTotal.toFixed(4)}); ending]`));
        event('engine.budget_breach', { usd: state.usdTotal, budget: spec.budget });
        break;
      }

      // post_response hook.
      try { await runPostResponse({ text, usage, stop_reason: stopReason, run_id: runId }); }
      catch (e) { event('hook.post_response.error', { msg: String(e) }); }

      if (stopReason === 'tool_use') {
        state.hadToolRounds = true;
        const toolUses = assistantContent.filter((b) => b.type === 'tool_use');
        const userIntent = extractUserIntent(state.messages);
        const results = await runToolCalls({ toolUses, registry, renderer, userIntent, toolSchemas, gitWarnedPaths: state.gitWarnedPaths });
        state.messages.push({ role: 'user', content: results });
        continue; // feed results back
      }

      // stop_reason = end_turn / max_tokens / stop_sequence.
      // Delegate the full Phase-A+B+C+D quality loop to the shared pipeline.
      // Observer hooks map to renderer.line() so the CLI output stays identical.
      const verifyResult = await runVerifyPipeline({
        state, systemBlocks, routed, spec,
        observer: {
          onRerunImproved: ({ prior_issues, new_issues }) =>
            renderer.line(C.grn(`[rerun-verify: improved · prior_issues=${prior_issues} → ${new_issues}]`)),
          onRerunRegressed: () =>
            renderer.line(C.red('[rerun-verify: regressed — rolling back to prior answer]')),
          onReviseQueued: ({ count, max, issues }) =>
            renderer.line(C.ylw(`[auto-verify: revise ${count}/${max} — injecting fix (issues=${issues})]`)),
          onReviseCeilingHit: ({ max }) =>
            renderer.line(C.ylw(`[auto-verify: revise ceiling ${max} reached — shipping with known issues]`)),
          onApproved: ({ confidence }) =>
            renderer.line(C.grn(`[auto-verify: approve · conf=${confidence ?? '?'}]`)),
          onPanelVerdict: ({ kind, consensus, panel }) =>
            renderer.line((kind === 'revise' ? C.ylw : C.grn)(
              `[panel-verify: ${kind} · conf=${consensus?.confidence} · personas=${(panel || []).map((p) => p.name).join('/')}]`,
            )),
          onBestOfNReplaced: ({ winner, candidates }) =>
            renderer.line(C.grn(`[best-of-N: replaced with ${winner} (candidates=${candidates.length})]`)),
        },
      });
      if (verifyResult.shouldContinue) continue;

      if (rl) saveSession({ home, sessionId, messages: state.messages, model: routed.model, systemBundle });
      if (!spec.interactive) break;
      if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
          Number.isFinite(spec.budget) && spec.budget > 0 &&
          state.usdTotal >= spec.budget) {
        renderer.line(C.ylw(`[budget $${spec.budget} reached; usd_total=${state.usdTotal.toFixed(4)}]`));
        break;
      }
      // Loop → top of while → prompt for next user message.
    }
  } catch (e) {
    renderer.line(C.red(`[engine error] ${e.message}`));
    event('engine.error', { msg: e.message });
    return { code: 1, finalAnswer: state.finalAnswer, usdTotal: state.usdTotal };
  } finally {
    process.removeListener('SIGINT', onSig);
    process.removeListener('SIGTERM', onSig);
    if (rl) rl.close();
    registry.shutdown();
  }

  // Final handoff summary (silent if interactive; visible for one-shots).
  try {
    const card = computeHandoff({ messages: state.messages, usdTotal: state.usdTotal, verifyVerdict: state.lastVerify });
    if (!spec.interactive) renderer.line('\n' + renderHandoff(card));
  } catch (e) { event('handoff.error', { msg: String(e) }); }

  saveSession({ home, sessionId, messages: state.messages, model: routed.model, systemBundle });
  return { code: 0, finalAnswer: state.finalAnswer, usdTotal: state.usdTotal };
}

// extractUserIntent lives in core_helpers.mjs.
