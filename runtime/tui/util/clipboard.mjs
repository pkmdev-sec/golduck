/* ─────────────────────────────────────────────────────────────────────────
 * clipboard — cross-platform copy-to-clipboard helper.
 * ─────────────────────────────────────────────────────────────────────────
 * Pure ESM. No deps. Used by the history pane to pipe `asCopyText()` output
 * into the host OS clipboard.
 *
 * Provider selection:
 *   macOS:          pbcopy
 *   Linux/Wayland:  wl-copy        (when $WAYLAND_DISPLAY is set)
 *   Linux/X11:      xclip -selection clipboard, then xsel -b -i
 *   Windows / WSL:  clip.exe       (WSL detected via /proc/version)
 *
 * Both entry points are total: missing binaries surface as a result object,
 * never a thrown error.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { delimiter as PATH_DELIM } from 'node:path';

const IS_WIN = process.platform === 'win32';

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    const v = readFileSync('/proc/version', 'utf8');
    return /microsoft/i.test(v);
  } catch {
    return false;
  }
}

function whichSync(bin) {
  const path = process.env.PATH || '';
  if (!path) return null;
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of path.split(PATH_DELIM)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${bin}${ext}`.replace(/\\+/g, '/');
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function providerOrder() {
  if (process.platform === 'darwin') return ['pbcopy'];
  if (IS_WIN) return ['clip.exe', 'clip'];
  if (isWsl()) return ['clip.exe'];
  if (process.platform === 'linux') {
    const order = [];
    if (process.env.WAYLAND_DISPLAY) order.push('wl-copy');
    order.push('xclip', 'xsel');
    // If WAYLAND_DISPLAY is unset but wl-copy still exists, allow it last.
    if (!process.env.WAYLAND_DISPLAY) order.push('wl-copy');
    return order;
  }
  return [];
}

function argsFor(bin) {
  switch (bin) {
    case 'xclip':
      return ['-selection', 'clipboard'];
    case 'xsel':
      return ['-b', '-i'];
    default:
      return [];
  }
}

export function detectClipboardMethod() {
  for (const bin of providerOrder()) {
    if (whichSync(bin)) return bin;
  }
  return null;
}

export function copyToClipboard(text) {
  return new Promise((resolve) => {
    const payload = typeof text === 'string' ? text : String(text ?? '');
    const method = detectClipboardMethod();
    if (!method) {
      resolve({ ok: false, method: 'none', error: 'no clipboard provider found' });
      return;
    }
    let child;
    try {
      child = spawn(method, argsFor(method), { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, method, error: err?.message || String(err) });
      return;
    }

    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      const msg = err?.code === 'ENOENT'
        ? `clipboard binary not found: ${method}`
        : (err?.message || String(err));
      done({ ok: false, method, error: msg });
    });
    child.on('close', (code) => {
      if (code === 0) done({ ok: true, method });
      else done({ ok: false, method, error: stderr.trim() || `exit code ${code}` });
    });

    try {
      child.stdin.end(payload);
    } catch (err) {
      done({ ok: false, method, error: err?.message || String(err) });
    }
  });
}
