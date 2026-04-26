/* ─────────────────────────────────────────────────────────────────────────
 * Persistent prompt history (runtime/tui/history_store.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Append-only newline-delimited JSON of every user prompt.
 * Shape: { ts, run_id, text, cwd }
 * Location: $GOLDUCK_HOME/state/history.jsonl
 *
 * Used by the /rev (^R) reverse-history overlay and any future slash
 * commands that want to "recall what I asked last Tuesday".
 * ───────────────────────────────────────────────────────────────────────── */
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function file() {
  const home = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  return join(home, 'state', 'history.jsonl');
}

export function recordPrompt(text, meta = {}) {
  if (!text || typeof text !== 'string') return;
  try {
    const f = file();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify({
      ts: new Date().toISOString(),
      run_id: meta.run_id || process.env.GOLDUCK_RUN_ID || null,
      cwd: process.cwd(),
      text,
    }) + '\n');
  } catch { /* best-effort */ }
}

export function loadHistory({ limit = 1000 } = {}) {
  const f = file();
  if (!existsSync(f)) return [];
  try {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
