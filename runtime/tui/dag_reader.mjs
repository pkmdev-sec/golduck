/* ─────────────────────────────────────────────────────────────────────────
 * dag_reader.mjs — scan declared DAGs and read active DAG run status.
 * ─────────────────────────────────────────────────────────────────────────
 * - listDags()        → declared DAGs in $GOLDUCK_HOME/dags/ (*.json|*.yaml|*.yml)
 * - readDagStatus()   → $GOLDUCK_HOME/state/dag/<runId>.json (or newest)
 * Graceful: never throws. Returns empty shapes on any IO/parse error.
 * ───────────────────────────────────────────────────────────────────────── */
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';

function goldHome(home) {
  return home || process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
}

const DAG_EXTS = new Set(['.json', '.yaml', '.yml']);

export function listDags({ home = null } = {}) {
  try {
    const dir = join(goldHome(home), 'dags');
    if (!existsSync(dir)) return [];
    const out = [];
    for (const entry of readdirSync(dir)) {
      const ext = extname(entry).toLowerCase();
      if (!DAG_EXTS.has(ext)) continue;
      const path = join(dir, entry);
      let mtime = 0;
      try { mtime = statSync(path).mtimeMs || 0; } catch {}
      out.push({ name: basename(entry, ext), path, mtime });
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  } catch {
    return [];
  }
}

function newestStatusFile(dir) {
  try {
    if (!existsSync(dir)) return null;
    let best = null;
    let bestMtime = -1;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const p = join(dir, entry);
      let m = 0;
      try { m = statSync(p).mtimeMs || 0; } catch {}
      if (m > bestMtime) { bestMtime = m; best = p; }
    }
    return best;
  } catch { return null; }
}

export function readDagStatus({ home = null, runId = null } = {}) {
  try {
    const dir = join(goldHome(home), 'state', 'dag');
    const target = runId ? join(dir, `${runId}.json`) : newestStatusFile(dir);
    if (!target || !existsSync(target)) return { steps: [] };
    const raw = readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw);
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const out = { steps };
    if (parsed.run_id) out.run_id = String(parsed.run_id);
    return out;
  } catch {
    return { steps: [] };
  }
}
