/* ─────────────────────────────────────────────────────────────────────────
 * golduck reflect scheduler (runtime/reflect/schedule.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Post-run self-reflection: if the run was complex/deep, run a short
 * "lessons learned" pass that:
 *   - extracts the concrete patches/files touched
 *   - writes a dense one-paragraph journal entry to memory
 *   - optionally mints a new skill if the same pattern recurs often
 *
 * Unlike verify, reflect is *about process improvement*, not correctness.
 * It's how golduck gets better over time.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { event } from '../trace/tracer.mjs';

export async function scheduleReflect({ spec, ctx, routed, code }) {
  if (routed.reflect === 'off' || routed.reflect === false) return { skipped: true };
  if (code !== 0) return { skipped: true, reason: 'frontend_failed' };

  const runnerPy = join(process.env.GOLDUCK_ROOT || '', 'runtime', 'reflect', 'run_reflect.py');
  if (!existsSync(runnerPy)) return { skipped: true, reason: 'no_runner' };

  const py = process.env.PY_BIN || 'python3';
  event('reflect.start', { depth: routed.reflect });

  return new Promise((resolve) => {
    const child = spawn(py, [runnerPy, '--depth', String(routed.reflect)], {
      env: { ...process.env, GOLDUCK_ROUTED: JSON.stringify(routed) },
      stdio: 'inherit',
    });
    const timeout = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 90000);
    child.on('exit', (c) => { clearTimeout(timeout); event('reflect.exit', { code: c }); resolve({ code: c }); });
    child.on('error', (e) => { event('reflect.error', { error: String(e) }); resolve({ error: String(e) }); });
  });
}
