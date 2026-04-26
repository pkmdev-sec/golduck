#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck native orchestrator (runtime/core/orchestrate.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Single entry. golduck is its own harness — no codex/droid dispatch.
 *
 * Pipeline per run:
 *   1. parse argv → RunSpec
 *   2. load RunContext (repo, AGENTS chain, hooks, skills, memory,
 *      constitution, cost ledger, recent journal, lessons learned)
 *   3. route → {tier, model, thinking, verify, reflect, personas, fanout}
 *   4. governance gate (constitution, trust, budget) — fail-closed
 *   5. build the system bundle (AGENTS + constitution + pins + directives)
 *   6. launch the native engine (runtime/engine/engine.mjs):
 *      - interactive TTY mode (prompt loop) OR
 *      - one-shot (single --prompt + exit)
 *      - streams thinking, tool_use, tool_result, assistant text
 *      - runs the full tool suite (shell, apply_patch, fs, rlm, memory,
 *        mcp clients) in parallel when the model emits multiple tool_use.
 *   7. on exit: verify + reflect (inline for complex runs) → write lesson
 *   8. record spend
 *   ─────────────────────────────────────────────────────────────────── */

import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { route } from '../router/router.mjs';
import { loadRunContext } from '../context/context.mjs';
import { buildSystemBundle } from '../context/bundle.mjs';
import { openTrace, event, closeTrace } from '../trace/tracer.mjs';
import { enforcePrelude, enforcePostlude } from '../governance/gates.mjs';
import { runEngine } from '../engine/engine.mjs';
import { scheduleVerifyInline } from '../verify/inline.mjs';
import { scheduleReflect } from '../reflect/schedule.mjs';
import { recordSpend } from '../memory/budget.mjs';

function parseArgv(argv) {
  const out = {
    mode: 'native',
    model: process.env.GOLDUCK_MODEL || null,
    verify: process.env.GOLDUCK_VERIFY || 'auto',
    reflect: process.env.GOLDUCK_REFLECT || 'auto',
    persona: process.env.GOLDUCK_PERSONA || null,
    budget: parseFloat(process.env.GOLDUCK_BUDGET_USD || 'Infinity'),
    // Run-level safety budget applies unconditionally (no env var required).
    // Default $10 guards against runaway loops. Set to 0 to disable entirely,
    // or set GOLDUCK_SAFETY_BUDGET_USD to a positive value to tune.
    safetyBudget: parseFloat(process.env.GOLDUCK_SAFETY_BUDGET_USD || '10'),
    max_turns: parseInt(process.env.GOLDUCK_MAX_TURNS || '80', 10),
    fast: false,
    trace: process.env.GOLDUCK_TRACE === '1',
    dryRun: false,
    interactive: null, // auto: TTY ? true : false
    prompt: null,
    resume: null, // session id to resume
    session: null,
    passthrough: [],
  };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    switch (a) {
      case '-m': case '--model':   out.model = args.shift(); break;
      case '--verify':             out.verify = args.shift(); break;
      case '--reflect':            out.reflect = args.shift(); break;
      case '--persona':            out.persona = args.shift(); break;
      case '--budget':             out.budget = parseFloat(args.shift()); break;
      case '--max-turns':          out.max_turns = parseInt(args.shift(), 10); break;
      case '--fast':               out.fast = true; break;
      case '--trace':              out.trace = true; break;
      case '--dry-run':            out.dryRun = true; break;
      case '-i': case '--interactive': out.interactive = true; break;
      case '--oneshot':            out.interactive = false; break;
      case '--prompt': case '-p':  out.prompt = args.shift(); break;
      case '--resume':             out.resume = args.shift(); break;
      case '--session':            out.session = args.shift(); break;
      case '--':                   out.passthrough.push(...args); args.length = 0; break;
      default:                     out.passthrough.push(a);
    }
  }
  if (!out.prompt && out.passthrough.length && !out.passthrough[0].startsWith('-')) {
    out.prompt = out.passthrough.join(' ');
  }
  if (out.fast) { out.verify = 'off'; out.reflect = 'off'; }
  if (out.interactive === null) out.interactive = Boolean(process.stdin.isTTY) && !out.prompt;
  return out;
}

async function main() {
  const spec = parseArgv(process.argv.slice(2));
  const runId = spec.resume || randomUUID().slice(0, 12);
  const sessionId = spec.session || runId;
  const home = process.env.GOLDUCK_HOME || join(process.env.HOME, '.golduck');
  const traceFile = join(home, 'traces', `${runId}.jsonl`);
  mkdirSync(join(home, 'traces'), { recursive: true });
  try {
    const cur = join(home, 'traces', 'current.jsonl');
    if (existsSync(cur)) { try { unlinkSync(cur); } catch {} }
    try { symlinkSync(traceFile, cur); } catch { writeFileSync(cur, ''); }
  } catch {}

  openTrace({ runId, traceFile });

  const ctx = await loadRunContext({ runId, home, traceFile, cwd: process.cwd() });
  const routed = route({ prompt: spec.prompt || '', spec, ctx });
  if (!spec.model) spec.model = routed.model;

  event('route.decision', routed);

  // Build system bundle (the quality multiplier).
  const systemBundle = buildSystemBundle({ ctx, routed, spec });
  const bundlePath = join(home, 'tmp', `bundle-${runId}.md`);
  mkdirSync(join(home, 'tmp'), { recursive: true });
  writeFileSync(bundlePath, systemBundle);
  event('bundle.written', { path: bundlePath, bytes: systemBundle.length });

  const gate = enforcePrelude({ spec, ctx, routed });
  if (!gate.allowed) {
    console.error(`\x1b[31m[golduck] BLOCKED:\x1b[0m ${gate.reason}`);
    event('gate.blocked', gate);
    closeTrace();
    process.exit(3);
  }
  if (gate.warnings?.length) {
    for (const w of gate.warnings) console.error(`\x1b[33m[golduck] ${w}\x1b[0m`);
  }

  if (spec.dryRun) {
    console.log(JSON.stringify({
      runId, sessionId, spec, routed, gate,
      ctx_summary: ctx.summary,
      bundle_bytes: systemBundle.length,
    }, null, 2));
    closeTrace();
    return;
  }

  // ── Launch the native engine. It owns the conversation loop. ──
  const engineResult = await runEngine({
    runId, sessionId, home, traceFile,
    spec, ctx, routed, systemBundle,
  });

  enforcePostlude({ spec, ctx, routed, code: engineResult.code });

  // Post-run verify (inline, synchronous): panel-critic on final answer.
  let verifyVerdict = null;
  if (routed.verify === 'on' && engineResult.finalAnswer) {
    try {
      verifyVerdict = await scheduleVerifyInline({
        runId, home, traceFile,
        question: spec.prompt || '(interactive session)',
        answer: engineResult.finalAnswer,
        routed,
      });
      event('verify.verdict', verifyVerdict);
      if (verifyVerdict?.verdict === 'revise') {
        console.error(`\x1b[33m[golduck] verify: revise — ${(verifyVerdict.issues || []).slice(0,3).join('; ')}\x1b[0m`);
      } else if (verifyVerdict?.verdict === 'approve') {
        console.error(`\x1b[32m[golduck] verify: approve (confidence=${verifyVerdict.confidence})\x1b[0m`);
      }
    } catch (e) {
      event('verify.error', { msg: String(e) });
    }
  }

  // Reflect (async, non-blocking).
  if (routed.reflect !== 'off' && engineResult.code === 0) {
    try { await scheduleReflect({ spec, ctx, routed, code: engineResult.code }); } catch {}
  }

  await recordSpend({ runId, home, code: engineResult.code, usd: engineResult.usdTotal || 0 });

  closeTrace();
  process.exit(engineResult.code || 0);
}

main().catch((e) => {
  console.error('[golduck] orchestrator fatal:', e?.stack || e?.message || String(e));
  try { event('orchestrator.fatal', { msg: String(e?.message || e) }); } catch {}
  try { closeTrace(); } catch {}
  process.exit(99);
});
