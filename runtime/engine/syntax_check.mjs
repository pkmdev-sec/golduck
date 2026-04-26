/* ─────────────────────────────────────────────────────────────────────────
 * golduck post-edit syntax validator (runtime/engine/syntax_check.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * After any successful apply_patch or write on a source file, we run a
 * cheap syntax check in the language's native parser. Any syntax error
 * is appended to the tool_result so the model sees it immediately and
 * can auto-fix on the next turn, instead of discovering it at test time.
 *
 * Supported:
 *   .mjs / .js / .cjs   → node --check
 *   .json               → JSON.parse
 *   .py                 → python3 -c "import ast; ast.parse(open(f).read())"
 *   .ts / .tsx          → node --check (best-effort; falls back silently)
 *
 * We intentionally don't fail the tool call on syntax error — we just
 * annotate the result. The model gets the surfaced diagnostic and can
 * react. This matches the "surface problems, don't block" philosophy of
 * golduck's tool pipeline.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { event } from '../trace/tracer.mjs';

function checkMjs(path) {
  const r = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0) return null;
  return (r.stderr || r.stdout || 'unknown syntax error').split('\n').slice(0, 4).join('\n');
}

function checkJson(path) {
  try { JSON.parse(readFileSync(path, 'utf8')); return null; }
  catch (e) { return String(e.message || e).slice(0, 400); }
}

function checkPy(path) {
  const py = process.env.PY_BIN || 'python3';
  const r = spawnSync(py, ['-c', `import ast,sys; ast.parse(open('${path.replace(/'/g, "\\'")}').read())`], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0) return null;
  return (r.stderr || r.stdout || 'unknown syntax error').split('\n').slice(0, 4).join('\n');
}

export function validatePath(path) {
  if (!path || !existsSync(path)) return null;
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.mjs' || ext === '.js' || ext === '.cjs' || ext === '.ts' || ext === '.tsx') {
      const err = checkMjs(path);
      if (err) return { path, kind: 'js', error: err };
    } else if (ext === '.json') {
      const err = checkJson(path);
      if (err) return { path, kind: 'json', error: err };
    } else if (ext === '.py') {
      const err = checkPy(path);
      if (err) return { path, kind: 'python', error: err };
    }
  } catch (e) {
    // Never crash the engine due to a syntax check.
    event('syntax_check.fatal', { path, msg: String(e) });
  }
  return null;
}

/** Given a tool result from apply_patch / write, validate each touched
 *  file and return a string to APPEND to the tool_result content.
 *  Empty string if no issues. */
export function validateAfter(toolName, result) {
  if (!result || result.ok === false) return '';
  const touched = [];
  if (toolName === 'apply_patch' && Array.isArray(result.ops)) {
    for (const op of result.ops) {
      if (op.kind === 'add' || op.kind === 'update') touched.push(op.path);
    }
  } else if (toolName === 'write' && result.path) {
    touched.push(result.path);
  }
  if (!touched.length) return '';
  const issues = [];
  for (const p of touched) {
    const v = validatePath(p);
    if (v) issues.push(v);
  }
  if (!issues.length) return '';
  event('syntax_check.issues', { count: issues.length, tool: toolName });
  return '\n\n⚠ golduck syntax-check issues:\n' +
    issues.map((i) => `- ${i.path} [${i.kind}]\n  ${i.error.replace(/\n/g, '\n  ')}`).join('\n');
}
