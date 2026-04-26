/* ─────────────────────────────────────────────────────────────────────────
 * golduck git-dirty warning (runtime/engine/git_check.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Runs at most once per run, right before the FIRST edit-intent tool
 * call. If the target file (or its repo) has uncommitted changes, append
 * a one-line warning to the tool_result so the model is visibly aware.
 *
 * Philosophy: warn, never block. If the user's prompt says "refactor X",
 * editing over uncommitted work is usually fine — the commit is the
 * user's responsibility. But make it impossible to miss.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawnSync } from 'node:child_process';
import { dirname, resolve as presolve } from 'node:path';

function gitRoot(path) {
  const r = spawnSync('git', ['-C', dirname(presolve(path)), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function statusOf(path) {
  const r = spawnSync('git', ['-C', dirname(presolve(path)), 'status', '--porcelain=v1', '--', path], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

/** Returns a warning string or '' if the target is clean. */
export function gitDirtyWarning(path) {
  if (!path) return '';
  const root = gitRoot(path);
  if (!root) return '';
  const st = statusOf(path);
  if (!st) return '';
  return `\n\n[golduck] ${path} has uncommitted changes: ${st.slice(0, 240)}`;
}
