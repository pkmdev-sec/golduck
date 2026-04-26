/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI engine adapter (runtime/tui/engine_tui.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Mirrors the native engine's conversation loop but emits events into the
 * TUI store instead of printing to stdout. Reuses every subsystem:
 *   - streaming client (adaptive thinking)
 *   - tool registry (incl. MCP federation)
 *   - input validation, safety, hooks
 *   - syntax check + git dirty warnings + injection sniffer
 *   - retry + compact + tool summarize
 *   - auto-verify + rerun-verify + rollback
 *   - cross-session recall (TF-IDF) — surfaced as a store event too
 *
 * Everything that used to renderer.line/raw() now store.push()s.
 * ───────────────────────────────────────────────────────────────────────── */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { buildRegistry }        from '../engine/registry.mjs';
import { maybeCompact, estimateTokens } from '../engine/compact.mjs';
import { summarizeIfHuge }      from '../engine/tool_summarize.mjs';
import { safetyCheck }          from '../engine/safety.mjs';
import { withRetry }            from '../engine/retry.mjs';
import { runPreRequest, runPostResponse, runOnTool } from '../engine/hooks.mjs';
import { autoVerify, rerunVerify } from '../engine/auto_verify.mjs';
import { panelVerify }          from '../engine/panel_verify.mjs';
import { maybeBestOfN, adaptiveSamples } from '../engine/best_of_n.mjs';
import { runVerifyPipeline }     from '../engine/verify_pipeline.mjs';
import { buildPlan, buildPlanWithCritique, critiquePlan, renderPlan, shouldPlan } from '../engine/planner.mjs';
import { buildRefresh, memoryMtimes }         from '../memory/refresh.mjs';
import { validateAfter as syntaxValidateAfter } from '../engine/syntax_check.mjs';
import { validateToolInput }    from '../engine/input_validate.mjs';
import { gitDirtyWarning }      from '../engine/git_check.mjs';
import { computeHandoff }       from '../engine/handoff.mjs';
import { saveSession }          from '../engine/engine.mjs';
import { scheduleReflect }      from '../reflect/schedule.mjs';
import { recordSpend }          from '../memory/budget.mjs';
import { event, span }          from '../trace/tracer.mjs';
import { recall }               from '../memory/recall.mjs';
import { analyzePrompt, summarizeForToast } from './preflight.mjs';
import { maybeAutoLesson }      from '../memory/lessons.mjs';
import { scheduleFactExtract } from '../memory/fact_extract.mjs';
import { recordPrompt }         from './history_store.mjs';
import { snapshotBeforePatch, snapshotBeforeWrite } from './patch_snapshot.mjs';
import { cacheKey, getCached, setCached, invalidateAll, invalidateByPrefix, pathsForTool } from '../engine/tool_cache.mjs';
import { validateToolResult } from '../engine/output_validate.mjs';
import { dispatchToolCalls as _sharedDispatchToolCalls } from '../engine/turn.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');

// Turn-scoped abort controller. TUI calls cancelCurrentTurn() on esc-during-busy.
let turnAbort = null;
export function cancelCurrentTurn(reason = 'user_cancel') {
  if (turnAbort && !turnAbort.signal.aborted) {
    try { turnAbort.abort(reason); } catch {}
  }
}
const LAST_PATCH_FILE = () => join(HOME(), 'state', 'last_patch.txt');

const TOOL_CONCURRENCY = parseInt(process.env.GOLDUCK_TOOL_CONCURRENCY || '6', 10);

// Shared helpers live in core_helpers.mjs. See the import on the next line.
import { usd, summarizeResult, errorHint, toolResultContent, extractUserIntent } from '../engine/core_helpers.mjs';

function resolveThinking(routed) {
  const envBudget = parseInt(process.env.GOLDUCK_THINKING_BUDGET || '0', 10);
  if (envBudget > 0) return { ...(routed.thinking || { type: 'enabled' }), budget_tokens: envBudget };
  return routed.thinking;
}

function persistLastPatch(patchText) {
  if (!patchText) return;
  try {
    const f = LAST_PATCH_FILE();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, String(patchText));
  } catch {}
}

async function oneTurn({ model, system, messages, tools, thinking, max_tokens, store }) {
  const body = buildRequestBody({ model, system, messages, tools, thinking, max_tokens });
  event('engine.request', { model, tool_count: tools.length, msg_count: messages.length });

  const iter = await withRetry('messages', () => streamMessages(body, {
    headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
    signal: turnAbort?.signal || null,
  }), {
    onAttempt: ({ attempt, reason, wait_ms }) => {
      try { store.push('retry', { attempt, reason, wait_ms }); } catch {}
    },
  });

  const blocks = [];
  let usage = {};
  let stopReason = null;
  let assistantStarted = false;
  let text = '';

  for await (const ev of iter) {
    if (ev.type === 'message_start') {
      usage = { ...usage, ...(ev.message?.usage || {}) };
    } else if (ev.type === 'content_block_start') {
      const blk = { ...ev.content_block };
      blocks[ev.index] = blk;
      if (blk.type === 'text' && !assistantStarted) {
        store.push('assistant_start', {});
        store.push('stream_start', {});
        assistantStarted = true;
      } else if (blk.type === 'tool_use') {
        blk.inputStr = '';
      }
    } else if (ev.type === 'content_block_delta') {
      const blk = blocks[ev.index] || {};
      const d = ev.delta;
      if (d?.type === 'text_delta') {
        blk.text = (blk.text || '') + d.text;
        text += d.text;
        store.push('assistant_text', { delta: d.text });
        store.push('stream_tick', { deltaTokens: Math.max(1, Math.floor((d.text || '').length / 4)) });
      } else if (d?.type === 'thinking_delta') {
        blk.thinking = (blk.thinking || '') + d.thinking;
      } else if (d?.type === 'input_json_delta') {
        blk.inputStr = (blk.inputStr || '') + (d.partial_json || '');
      } else if (d?.type === 'signature_delta') {
        blk.signature = d.signature;
      }
      blocks[ev.index] = blk;
    } else if (ev.type === 'content_block_stop') {
      const blk = blocks[ev.index];
      if (blk?.type === 'thinking' && blk.thinking) {
        const lines = blk.thinking.split('\n').length;
        store.push('thinking_summary', {
          lines, chars: blk.thinking.length,
          preview: blk.thinking.replace(/\s+/g, ' ').slice(0, 80),
        });
        event('engine.thinking', { lines, chars: blk.thinking.length });
      }
      if (blk?.type === 'tool_use') {
        if (blk.inputStr) {
          try { blk.input = JSON.parse(blk.inputStr); }
          catch { blk.input = { _raw: blk.inputStr, _error: 'invalid_json' }; }
        }
        store.push('tool_use', { id: blk.id, name: blk.name, input: blk.input || {} });
        // Snapshot apply_patch payloads so the /diff overlay can render them later.
        if (blk.name === 'apply_patch' && blk.input?.patch) persistLastPatch(blk.input.patch);
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      usage = { ...usage, ...(ev.usage || {}) };
    } else if (ev.type === 'message_stop') {
      store.push('stream_stop', {});
      break;
    } else if (ev.type === 'error') {
      throw new Error(`API error: ${JSON.stringify(ev.error || ev).slice(0, 400)}`);
    }
  }

  const assistantContent = blocks.filter(Boolean).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text || '' };
    if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking || '', signature: b.signature };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    return null;
  }).filter(Boolean);

  event('engine.response', { stop_reason: stopReason, usage, model });

  const est = estimateTokens(messages, system);
  const ctx_pct = Math.round((est / 1_000_000) * 1000) / 10;
  store.push('usage', {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_input_tokens,
    cache_write: usage.cache_creation_input_tokens,
    usd: usd(usage, model),
    ctx_pct,
  });

  return { assistantContent, stopReason, usage, text };
}

async function runToolCalls({ toolUses, registry, store, userIntent, toolSchemas, gitWarnedPaths }) {
  // Thin TUI adapter around the shared turn.mjs dispatch pipeline. Observer
  // maps to store.push events so the ink layer renders tool_use / tool_done
  // cells; everything else is shared with the CLI engine.
  const observer = {
    onToolUseStart: (e) => store.push('tool_use', { id: e.id, name: e.name, input: e.input || {} }),
    onToolDone: (e) => store.push('tool_done', { id: e.id, ok: e.ok, summary: e.summary, duration_ms: e.duration_ms }),
  };
  return _sharedDispatchToolCalls({
    toolUses, registry, userIntent, toolSchemas, gitWarnedPaths,
    snapshotBeforePatch, snapshotBeforeWrite,
    observer, concurrency: TOOL_CONCURRENCY,
  });
}

// summarizeResult / errorHint / toolResultContent / extractUserIntent come from core_helpers.mjs.

export async function runEngineTui({
  runId, home, traceFile, spec, ctx, routed, systemBundle,
  store, waitForNext, onBusy, exitAfter = false,
}) {
  const registry = await buildRegistry();
  const toolSchemas = registry.tools;

  // Publish the tool catalog to the store (Tools overlay + status line).
  store.push('tool_catalog', { tools: toolSchemas });
  try {
    const catalogPath = join(HOME(), 'tmp', 'tools-catalog.json');
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(catalogPath, JSON.stringify(
      toolSchemas.map((t) => ({ name: t.name, description: t.description || '' })),
      null, 2,
    ));
  } catch {}
  store.push('banner', { toolCount: toolSchemas.length });

  let systemBlocks = [
    { type: 'text', text: systemBundle, cache_control: { type: 'ephemeral' } },
  ];
  process.env.GOLDUCK_RUN_ID = runId;
    if (routed?.fanout_cap) process.env.GOLDUCK_FANOUT_CAP = String(routed.fanout_cap);

  let messages = [];
  let usdTotal = 0;
  let turns = 0;
  let hadToolRounds = false;
  let autoRevised = false;
  let autoRevisions = 0;
  let priorVerdict = null;
  let priorAnswer = null;
  let finalAnswer = '';
  const gitWarnedPaths = new Set();
  let lastVerify = null;
  // Per-session planner state (parity with CLI engine's state.*):
  let lastPlannedFor = null;   // messages.length when we last built a plan
  let currentPlan = null;      // last active plan IR
  let lastRefreshMs = 0;       // memory refresh watermark

  const setBusy = (b, label = null) => {
    try { onBusy?.(b); } catch {}
    try { store.push('busy', { busy: b, label }); } catch {}
  };

  while (true) {
    // Wait for a user message.
    const userText = await waitForNext();
    if (!userText) break;
    if (userText === '/exit' || userText === '/quit') break;

    try { recordPrompt(userText, { run_id: runId }); } catch {}

    // Pre-flight: surface complexity + destructive warnings to the user.
    try {
      const pf = analyzePrompt(userText);
      if (pf.complexity !== 'trivial' || pf.warnings.length) {
        store.push('notice', {
          message: summarizeForToast(pf),
          kind: pf.warnings.length ? 'warn' : 'info',
        });
      }
    } catch {}

    // Cross-session recall surfaces a visible "≈ recalled" cell before the turn.
    try {
      const hits = recall({ query: userText, k: 3 });
      if (hits.length) store.push('recall', { hits, query: userText });
    } catch {}

    messages.push({ role: 'user', content: userText });

    let kept = true;
    while (kept) {
      kept = false;
      turns++;
      if (turns > spec.max_turns) {
        store.push('error', { message: `max_turns=${spec.max_turns} reached` });
        break;
      }
      turnAbort = new AbortController();
      setBusy(true, 'model');

      try {
        const hr = await runPreRequest({ messages, systemBytes: systemBundle.length, model: routed.model });
        if (hr.messages && hr.messages !== messages) messages = hr.messages;
      } catch {}

      try {
        // Structured pre-turn planner — parity with CLI engine.
        try {
          const freshUserTurn = !lastPlannedFor || lastPlannedFor !== messages.length;
          if (freshUserTurn && shouldPlan({ routed, spec, ctx })) {
            const ui = extractUserIntent(messages);
            const pr = await buildPlanWithCritique({
              userIntent: ui,
              budgetRemaining: spec.budget - usdTotal,
              thinkingBudget: Math.min(8000, (routed.thinking?.budget_tokens || 8000) / 2),
            });
            if (pr && pr.plan) {
              currentPlan = pr.plan;
              lastPlannedFor = messages.length;
              const planBlock = { type: 'text', text: renderPlan(pr.plan), cache_control: { type: 'ephemeral' }, _isPlan: true };
              systemBlocks = [planBlock, ...systemBlocks.filter((b) => b && !b._isPlan)];
              store.push('notice', { message: `plan: ${pr.plan.subgoals.length} subgoals · ${pr.plan.decompose}`, kind: 'info' });
            }
          }
        } catch (e) { event('plan.fatal', { msg: String(e) }); }

        // Mid-run memory refresh — TUI parity with CLI.
        try {
          if (lastPlannedFor === messages.length) {
            const ut = extractUserIntent(messages);
            const refresh = buildRefresh({ userText: ut, sinceMs: lastRefreshMs || 0 });
            if (refresh) {
              const refreshBlock = { type: 'text', text: refresh, cache_control: { type: 'ephemeral' }, _isRefresh: true };
              systemBlocks = [
                ...systemBlocks.filter((b) => b && !b._isRefresh),
                refreshBlock,
              ];
              const mt = memoryMtimes();
              lastRefreshMs = Math.max(mt.facts, mt.lessons, mt.journal, Date.now());
              event('memory.refresh_applied', { chars: refresh.length });
            }
          }
        } catch (e) { event('memory.refresh_error', { msg: String(e) }); }

        const c = await maybeCompact({ messages, system: systemBlocks, model: routed.model });
        if (c.compacted) { messages = c.messages; store.push('compact', { est_tokens: c.est }); }
      } catch {}

      let turnResult;
      try {
        turnResult = await oneTurn({
          model: routed.model, system: systemBlocks, messages,
          tools: toolSchemas, thinking: resolveThinking(routed),
          max_tokens: routed.max_tokens, store,
        });
      } catch (e) {
        const msg = (e?.name === 'AbortError' || /aborted/i.test(e?.message || ''))
          ? 'cancelled by user (esc)'
          : (e?.message || String(e));
        store.push('error', { message: msg });
        setBusy(false);
        break;
      }
      const { assistantContent, stopReason, usage, text } = turnResult;
      usdTotal += usd(usage, routed.model);
      messages.push({ role: 'assistant', content: assistantContent });
      finalAnswer = text;

      try { await runPostResponse({ text, usage, stop_reason: stopReason, run_id: runId }); } catch {}

      if (stopReason === 'tool_use') {
        hadToolRounds = true;
        const toolUses = assistantContent.filter((b) => b.type === 'tool_use');
        setBusy(true, `tools(${toolUses.length})`);
        const userIntent = extractUserIntent(messages);
        const results = await runToolCalls({ toolUses, registry, store, userIntent, toolSchemas, gitWarnedPaths });
        messages.push({ role: 'user', content: results });
        kept = true;
        continue;
      }

      // End-of-turn quality loop — shared pipeline from verify_pipeline.mjs.
      // The TUI observer maps every stage to store.push + notice events so
      // the ink overlay sees the same signal the CLI gets via renderer.line.
      setBusy(true, 'verify');
      // Build a minimal state proxy over the TUI's local vars. The pipeline
      // mutates this object in place; we unpack back into scope after.
      const _verifyState = {
        messages, finalAnswer, autoRevised, autoRevisions,
        priorVerdict, priorAnswer, lastVerify,
        hadToolRounds, usdTotal,
      };
      let _verifyResult;
      try {
        _verifyResult = await runVerifyPipeline({
          state: _verifyState,
          systemBlocks,
          routed,
          spec,
          observer: {
            onRerunImproved: ({ verdict, new_issues }) =>
              store.push('verify', { verdict: 'improved', confidence: verdict?.confidence, issues: verdict?.issues || [] }),
            onRerunRegressed: ({ verdict }) =>
              store.push('verify', { verdict: 'regressed', confidence: verdict?.confidence, issues: verdict?.issues || [] }),
            onReviseQueued: ({ verdict, count }) =>
              store.push('verify', { verdict: 'revise', confidence: verdict.confidence, issues: verdict.issues || [], revision: count }),
            onReviseCeilingHit: ({ max }) =>
              store.push('notice', { kind: 'warn', message: `revise ceiling ${max} reached — shipping with known issues` }),
            onApproved: ({ verdict }) =>
              store.push('verify', { verdict: 'approve', confidence: verdict.confidence, issues: [] }),
            onPanelVerdict: ({ kind, consensus, panel }) =>
              store.push('verify', {
                verdict: kind,
                confidence: consensus?.confidence,
                issues: (panel || []).flatMap((x) => x.issues || []).slice(0, 6),
                panel: (panel || []).map((x) => ({ name: x.name, verdict: x.verdict, confidence: x.confidence })),
              }),
            onBestOfNReplaced: ({ winner, candidates }) =>
              store.push('notice', { kind: 'info', message: `best-of-N swapped in ${winner} (n=${candidates.length})` }),
          },
        });
      } catch (e) { event('verify_pipeline.fatal', { msg: String(e) }); _verifyResult = { shouldContinue: false }; }
      finally { setBusy(false); }

      // Unpack the state mutations the pipeline made.
      messages      = _verifyState.messages;
      finalAnswer   = _verifyState.finalAnswer;
      autoRevised   = _verifyState.autoRevised;
      autoRevisions = _verifyState.autoRevisions;
      priorVerdict  = _verifyState.priorVerdict;
      priorAnswer   = _verifyState.priorAnswer;
      lastVerify    = _verifyState.lastVerify;

      if (_verifyResult.shouldContinue) { kept = true; continue; }

      // Run-level safety budget (always on unless 0/disabled).
      const sb = Number.isFinite(spec.safetyBudget) ? spec.safetyBudget : 10;
      if (sb > 0 && usdTotal >= sb) {
        store.push('error', { message: `safety-budget ${sb} reached (usd=${usdTotal.toFixed(4)}); aborting run` });
        event('engine.safety_budget_breach', { usd: usdTotal, safety_budget: sb });
        setBusy(false);
        return;
      }
      if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
          Number.isFinite(spec.budget) && spec.budget > 0 &&
          usdTotal >= spec.budget) {
        store.push('error', { message: `budget ${spec.budget} reached (usd=${usdTotal.toFixed(4)})` });
        setBusy(false);
        return;
      }
      setBusy(false);
      // End the inner while; wait for next user input.
    }

    // Render handoff at each natural end of conversation.
    try {
      const card = computeHandoff({ messages, usdTotal, verifyVerdict: lastVerify });
      store.push('handoff', { ...card, usd_total: usdTotal });
    } catch {}

    // Autonomous per-turn session persistence.
    try {
      saveSession({ home, sessionId: runId, messages, model: routed.model, systemBundle });
    } catch {}

    // Record spend to the ledger (best-effort, fire-and-forget).
    try { recordSpend({ runId, home, code: 0, usd: usdTotal }); } catch {}

    // Post-turn reflect (if routed.reflect is on) — runs in background; we don't
    // await so the next user turn isn't blocked. The TUI surfaces a dim notice
    // when reflect starts/ends via trace events the user can watch in /trace.
    try {
      scheduleReflect({ spec, ctx, routed, code: 0 }).then((r) => {
        if (r && !r.skipped) {
          store.push('notice', { message: `reflect complete (exit=${r.code ?? '?'})`, kind: 'info' });
        }
      }).catch(() => {});
    } catch {}

    if (exitAfter) break;
  }
}
