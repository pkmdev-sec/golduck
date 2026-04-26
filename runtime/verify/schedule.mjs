/* ─────────────────────────────────────────────────────────────────────────
 * golduck verify scheduler (runtime/verify/schedule.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * LEGACY. The live path is scheduleVerifyInline() in runtime/verify/inline.mjs,
 * which is what runtime/core/orchestrate.mjs calls after the engine exits.
 *
 * This module remains as a pluggable background scheduler option: it can
 * delegate verify to a separate droidx-rlm MCP process. Not wired into the
 * default pipeline, but kept working so a future orchestrator that wants
 * out-of-band verify can reuse it unchanged.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { event } from '../trace/tracer.mjs';

function lastAssistantText(traceFile) {
  if (!existsSync(traceFile)) return null;
  try {
    const lines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
    // Walk from the end, looking for a payload.kind==='assistant_text' or equivalent
    // captured by the frontend's reflect hook. If nothing found, null.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (o.kind === 'assistant_text' || o.name === 'assistant.final') {
          return o.text || o.content || null;
        }
      } catch {}
    }
  } catch {}
  return null;
}

export async function scheduleVerify({ spec, ctx, routed, code }) {
  if (routed.verify !== 'on') return { skipped: true, reason: routed.verify };
  if (code !== 0) return { skipped: true, reason: 'frontend_failed' };

  const answer = lastAssistantText(ctx.traceFile);
  if (!answer) return { skipped: true, reason: 'no_assistant_text' };

  const node = process.env.NODE_BIN || 'node';
  const serverJs = join(process.env.DROIDX_RLM_DIR || '', 'server.mjs');
  if (!existsSync(serverJs)) {
    event('verify.skipped', { reason: 'no_rlm_server' });
    return { skipped: true, reason: 'no_rlm_server' };
  }

  event('verify.start', { personas: routed.persona });

  // Use droidx-rlm's rlm_verify tool via a single-shot stdio MCP invoke.
  // To avoid re-implementing the full MCP client here we spawn a child
  // that executes runtime/verify/run_verify.py which already knows how.
  const runnerPy = join(process.env.GOLDUCK_ROOT || '', 'runtime', 'verify', 'run_verify.py');
  const py = process.env.PY_BIN || 'python3';

  return new Promise((resolve) => {
    const child = spawn(py, [runnerPy, '--answer-file', ctx.traceFile, '--question', (spec.prompt || '').slice(0, 2000)], {
      env: { ...process.env, GOLDUCK_ROUTED: JSON.stringify(routed) },
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 120000);
    child.on('exit', (c) => { clearTimeout(timeout); event('verify.exit', { code: c }); resolve({ code: c }); });
    child.on('error', (e) => { event('verify.error', { error: String(e) }); resolve({ error: String(e) }); });
  });
}
