#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI entry (runtime/tui/entry.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Wires the ink React app to the native golduck engine.
 *
 *   1. Build run context + routed + system bundle (same as orchestrate.mjs).
 *   2. Render the ink <App/> with an onSubmit callback that pushes user
 *      messages into the engine's pending queue.
 *   3. Start the engine loop in parallel; every engine event (user,
 *      assistant, tool_use/done, thinking, compact, verify, handoff,
 *      usage, recall, tool_catalog, busy) lands in the store, which the
 *      React tree subscribes to.
 *
 * This entry is invoked by the `golduck tui` / `golduck` launcher when
 * stdin is a TTY. Non-TTY runs fall through to runtime/core/orchestrate
 * (line-streaming ANSI).
 *
 * Flags:
 *   -p, --prompt <text>      seed the first user turn
 *       --exit-after         drive one round-trip then quit (visual smoke)
 *       --ephemeral          wipe session state (~/.golduck/tmp/run-<id>)
 * ───────────────────────────────────────────────────────────────────────── */
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';

import { loadRunContext }    from '../context/context.mjs';
import { buildSystemBundle } from '../context/bundle.mjs';
import { route }             from '../router/router.mjs';
import { openTrace, closeTrace } from '../trace/tracer.mjs';
import { enforcePrelude }    from '../governance/gates.mjs';
import { App }               from './App.mjs';
import { getStore }          from './store.mjs';
import { runEngineTui }      from './engine_tui.mjs';
import { probeBaseUrl }      from '../engine/client.mjs';
import { detectProvider } from '../providers/registry.mjs';

const h = React.createElement;

async function main() {
  const runId = randomUUID().slice(0, 12);
  const home = process.env.GOLDUCK_HOME || join(process.env.HOME || '.', '.golduck');
  const traceFile = join(home, 'traces', `${runId}.jsonl`);
  mkdirSync(join(home, 'traces'), { recursive: true });
  try {
    const cur = join(home, 'traces', 'current.jsonl');
    if (existsSync(cur)) { try { unlinkSync(cur); } catch {} }
    try { symlinkSync(traceFile, cur); } catch { writeFileSync(cur, ''); }
  } catch {}
  openTrace({ runId, traceFile });

  const argv = process.argv.slice(2);
  let seedPrompt = null;
  let exitAfter = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-p' || argv[i] === '--prompt') { seedPrompt = argv[i + 1] || null; i++; }
    else if (argv[i] === '--exit-after') { exitAfter = true; }
  }
  const spec = {
    model: process.env.GOLDUCK_MODEL || null,
    verify: process.env.GOLDUCK_VERIFY || 'auto',
    reflect: process.env.GOLDUCK_REFLECT || 'auto',
    budget: parseFloat(process.env.GOLDUCK_BUDGET_USD || 'Infinity'),
    safetyBudget: parseFloat(process.env.GOLDUCK_SAFETY_BUDGET_USD || '10'),
    max_turns: parseInt(process.env.GOLDUCK_MAX_TURNS || '80', 10),
    prompt: null,          // interactive
    interactive: true,
    resume: null,
    session: null,
  };

  const ctx = await loadRunContext({ runId, home, traceFile, cwd: process.cwd() });
  const routed = route({ prompt: seedPrompt || '', spec, ctx });
  if (!spec.model) spec.model = routed.model;
  // Derive tier (provider name) from the model slug so the Header labels
  // the right provider from the first render.
  const _initialProvider = detectProvider(spec.model);
  spec.tier = _initialProvider.name;

  // Probe for a live /v1/messages proxy (cxr:8741 → droidx:8752 → fallback).
  // This sets the module-level cache in runtime/engine/client.mjs so every
  // subsequent streamMessages() call uses whichever proxy is actually up.
  try { await probeBaseUrl(); } catch {}

  const systemBundle = buildSystemBundle({ ctx, routed, spec });
  const bundlePath = join(home, 'tmp', `bundle-${runId}.md`);
  mkdirSync(join(home, 'tmp'), { recursive: true });
  writeFileSync(bundlePath, systemBundle);
  ctx.bundlePath = bundlePath;

  const gate = enforcePrelude({ spec, ctx, routed });
  if (!gate.allowed) {
    console.error(`\x1b[31m[golduck] BLOCKED:\x1b[0m ${gate.reason}`);
    closeTrace();
    process.exit(3);
  }

  const store = getStore();
  // Try to surface the current git branch in the banner right side.
  let branch = null;
  try {
    const { execSync } = await import('node:child_process');
    branch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch {}

  store.push('banner', {
    model: spec.model || routed.model,
    tier:  spec.tier  || routed.tier,
    thinking: routed.thinking,
    verify: routed.verify, reflect: routed.reflect,
    budget: spec.budget, toolCount: 0,
    branch,
  });

  // User-submit ↔ engine-loop rendezvous.
  const pending = seedPrompt ? [seedPrompt] : [];
  if (seedPrompt) store.push('user', { text: seedPrompt });
  let pendingResolve = null;

  const waitForNext = () => new Promise((r) => {
    if (pending.length) return r(pending.shift());
    pendingResolve = r;
  });

  const onSubmit = (text) => {
    if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(text); }
    else pending.push(text);
    store.push('user', { text });
  };

  // If stdin/stdout isn't a TTY and we have a seedPrompt, bail to the
  // non-interactive orchestrator via process.exec. In CI/pipes, don't fight
  // ink — run the line-stream engine.
  if (!process.stdout.isTTY && seedPrompt) {
    const { spawnSync } = await import('node:child_process');
    const runBin = join(process.env.GOLDUCK_ROOT || '', 'bin', 'golduck-run');
    if (runBin && existsSync(runBin)) {
      const r = spawnSync(runBin, ['-p', seedPrompt], { stdio: 'inherit' });
      process.exit(r.status ?? 0);
    }
  }

  // Default: render inline so the terminal's native scrollback just works
  // (Cmd+↑, mouse wheel, Shift+PgUp — all the familiar scroll paths). The
  // alt-screen buffer is still available for folks who prefer the vim-like
  // full-screen model via GOLDUCK_ALTSCREEN=1. GOLDUCK_NO_ALTSCREEN=1 is
  // kept as a back-compat alias.
  const ALT_ON  = '\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l';
  const ALT_OFF = '\x1b[?25h\x1b[?1049l';
  const useAlt = process.stdout.isTTY
    && process.env.GOLDUCK_ALTSCREEN === '1'
    && process.env.GOLDUCK_NO_ALTSCREEN !== '1';
  if (useAlt) { try { process.stdout.write(ALT_ON); } catch {} }

  // Restore on any exit path.
  const restore = () => { if (useAlt) { try { process.stdout.write(ALT_OFF); } catch {} } };
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });
  process.on('SIGTERM', () => { restore(); process.exit(143); });
  process.on('uncaughtException', (e) => { restore(); console.error('[golduck] uncaught:', e?.stack || e?.message); process.exit(99); });
  process.on('unhandledRejection', (e) => { restore(); console.error('[golduck] unhandled rejection:', e?.stack || e?.message || e); process.exit(99); });

  const inkInst = render(h(App, { onSubmit }), {
    // Use the real stdout; ink handles full repaint on alt-screen cleanly.
    patchConsole: false,
    exitOnCtrlC: false,
  });

  // Drive the engine loop.
  try {
    await runEngineTui({
      runId, home, traceFile, spec, ctx, routed, systemBundle,
      store, waitForNext,
      onBusy: () => {}, // store.push('busy', …) already handles UI; keep hook for back-compat
      exitAfter,
    });
  } catch (e) {
    store.push('error', { message: e?.message || String(e) });
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    closeTrace();
    inkInst.unmount();
    restore();
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('[golduck-tui] fatal:', e?.stack || e?.message);
  process.exit(99);
});
