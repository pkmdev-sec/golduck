/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI shared trace-file helpers (runtime/tui/util/trace_files.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Consolidates the readEvents / listRecentTraceFiles / percentile helpers
 * that were inlined in Agents, Metrics, Stats, and metrics_export. Using
 * a single implementation prevents drift (e.g. which overlay resolves
 * current.jsonl via realpath).
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Parse one JSONL trace file, returning the array of events (silent on bad lines). */
export function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** List up to `max` recent trace files from $GOLDUCK_HOME/traces, newest first.
 *  Always resolves `current.jsonl` via realpath so the live run is included. */
export function listRecentTraceFiles(home, { max = 20 } = {}) {
  const dir = join(home, 'traces');
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir);
  const paths = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const full = join(dir, n);
    try {
      // If current.jsonl is a symlink, record the target (avoids double-listing).
      if (n === 'current.jsonl') {
        try { paths.push(realpathSync(full)); } catch { paths.push(full); }
      } else {
        paths.push(full);
      }
    } catch {}
  }
  // De-dup (current target may equal a listed file).
  const dedup = [...new Set(paths)];
  const withMtime = dedup.map((f) => {
    try { return { f, m: statSync(f).mtimeMs }; } catch { return { f, m: 0 }; }
  }).sort((a, b) => b.m - a.m).slice(0, max);
  return withMtime.map((x) => x.f);
}

/** Percentile of a numeric array (sorted ascending). p in [0, 100]. */
export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Convenience: read + concat events across N recent trace files. */
export function readRecentEvents(home, { max = 20 } = {}) {
  const files = listRecentTraceFiles(home, { max });
  const out = [];
  for (const f of files) out.push(...readEvents(f));
  return out;
}
