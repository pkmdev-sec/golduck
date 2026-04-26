/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool: shell (runtime/tools/shell.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Runs a shell command. Fast path: bash -lc. Always streaming output
 * back to the engine for live UI. Kills on timeout, captures stdout+stderr
 * separately up to a cap, truncates middle (keeping head+tail).
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BYTES = 200_000;

export const SCHEMA = {
  name: 'shell',
  description:
    'Run a shell command (bash -lc). Returns merged stdout+stderr + exit code. ' +
    'Use sparingly; prefer read/glob/grep for inspection. Always quote paths with spaces. ' +
    'Long-running processes are killed at timeout_ms (default 120s). ' +
    'Set background:true for long-running daemons (dev servers, log tailers): returns immediately with {pid, log_path}. ' +
    'Pass stdin to feed standard input to the command.',
  input_schema: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'Shell command to run (passed to bash -lc).' },
      cwd: { type: 'string', description: 'Working directory (default = current).' },
      timeout_ms: { type: 'number', default: DEFAULT_TIMEOUT_MS },
      env: { type: 'object', description: 'Extra environment vars (merged with parent env).' },
      stdin: { type: 'string', description: 'Optional stdin for the command.' },
      background: { type: 'boolean', description: 'Detach and return {pid, log_path} without waiting.' },
      shell: { type: 'string', description: 'Override shell (default bash). Use sh to avoid login-profile sourcing.' },
    },
  },
};

function truncateMiddle(s, cap) {
  if (s.length <= cap) return s;
  const half = Math.floor((cap - 80) / 2);
  return s.slice(0, half) + `\n... [${s.length - cap} bytes elided] ...\n` + s.slice(-half);
}

export async function execute({ command, cwd = null, timeout_ms = DEFAULT_TIMEOUT_MS, env = {}, stdin = null, background = false, shell = 'bash' }, { onProgress } = {}) {
  const shellBin = ['bash', 'sh', 'zsh'].includes(shell) ? shell : 'bash';
  const shellArgs = shellBin === 'bash' ? ['-lc', command] : ['-c', command];

  // Background mode: detach, log to GOLDUCK_HOME/logs/bg-<pid>.log, return pid.
  if (background) {
    const { openSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const home = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
    const logDir = join(home, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `bg-${Date.now()}.log`);
    const out = openSync(logPath, 'a');
    const ps = spawn(shellBin, shellArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', out, out],
      detached: true,
    });
    ps.unref();
    return { ok: true, background: true, pid: ps.pid, log_path: logPath };
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const ps = spawn(shellBin, shellArgs, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: [stdin != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin != null && ps.stdin) {
      try { ps.stdin.end(String(stdin)); } catch {}
    }
    let out = '', err = '';
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');
    ps.stdout.on('data', (c) => {
      out += c;
      if (out.length > MAX_BYTES * 2) out = out.slice(-MAX_BYTES);
      if (onProgress) onProgress({ stream: 'stdout', chunk: c });
    });
    ps.stderr.on('data', (c) => {
      err += c;
      if (err.length > MAX_BYTES * 2) err = err.slice(-MAX_BYTES);
      if (onProgress) onProgress({ stream: 'stderr', chunk: c });
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { ps.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { ps.kill('SIGKILL'); } catch {} }, 2000);
    }, timeout_ms);
    ps.on('exit', (code, sig) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;
      const stdout = truncateMiddle(out, MAX_BYTES);
      const stderr = truncateMiddle(err, MAX_BYTES / 2);
      const merged = [stdout, stderr && `\n[stderr]\n${stderr}`].filter(Boolean).join('');
      resolve({
        ok: code === 0 && !killed,
        exit_code: code,
        signal: sig,
        killed,
        duration_ms,
        stdout_bytes: out.length,
        stderr_bytes: err.length,
        output: merged,
      });
    });
    ps.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e), output: '' });
    });
  });
}
