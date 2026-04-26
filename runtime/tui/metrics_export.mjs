/* ─────────────────────────────────────────────────────────────────────────
 * Metrics CSV exporter — mirrors the aggregation in overlays/Metrics.mjs and
 * overlays/Stats.mjs, but emits a flat CSV suitable for spreadsheet analysis
 * rather than an Ink overlay.
 *
 * Reads the most recent ~20 trace .jsonl files under $GOLDUCK_HOME/traces
 * (defaulting to ~/.golduck/traces), skips the `current.jsonl` symlink, sorts
 * by mtime descending, and synthesizes one row per run.
 *
 * Never throws — on error the exporter returns a header-only CSV or an empty
 * { path: '', rows: 0, error } shape so callers can surface the error to the
 * UI without crashing the TUI.
 * ───────────────────────────────────────────────────────────────────────── */
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const MAX_FILES = 20;

const CSV_HEADER = [
  'run_id',
  'started',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read',
  'cache_write',
  'tools',
  'tool_errors',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'verify',
].join(',');

function resolveHome(home) {
  if (home && typeof home === 'string') return home;
  return process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
}

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

function listRecentTraceFiles(home) {
  const traces = join(home, 'traces');
  if (!existsSync(traces)) return [];
  let entries = [];
  try { entries = readdirSync(traces); } catch { entries = []; }
  const files = entries
    .filter((f) => f.endsWith('.jsonl') && f !== 'current.jsonl')
    .map((f) => join(traces, f))
    .filter((p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    });
  return files
    .sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
    })
    .slice(0, MAX_FILES);
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(Math.floor(sortedAsc.length * p), sortedAsc.length - 1);
  return sortedAsc[idx];
}

function normalizeVerdict(v) {
  if (v === 'approve' || v === 'revise' || v === 'regressed') return v;
  if (v === 'pass') return 'approve';
  return '-';
}

function aggregateRun(file) {
  const evs = readEvents(file);
  const run = {
    run_id: '',
    started: '',
    model: '',
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    tools: 0,
    tool_errors: 0,
    p50_ms: null,
    p95_ms: null,
    p99_ms: null,
    verify: '-',
  };
  const toolLatencies = [];
  const modelCounts = new Map();
  let verifyRaw = null;

  for (const e of evs) {
    if (!run.run_id && e.run_id) run.run_id = e.run_id;
    if (e.name === 'trace.open' && e.ts) run.started = e.ts;
    if (!run.started && e.ts) run.started = e.ts;
    if (e.name === 'engine.response') {
      if (e.usage) {
        run.input_tokens += e.usage.input_tokens || 0;
        run.output_tokens += e.usage.output_tokens || 0;
        run.cache_read += e.usage.cache_read_input_tokens || 0;
        run.cache_write += e.usage.cache_creation_input_tokens || 0;
      }
      if (e.model) modelCounts.set(e.model, (modelCounts.get(e.model) || 0) + 1);
    }
    if (e.span === 'tool.call' && e.name !== 'span.exit') run.tools++;
    if (e.name === 'span.exit' && e.span === 'tool.call') {
      if (e.ok === false) run.tool_errors++;
      if (typeof e.duration_ms === 'number') toolLatencies.push(e.duration_ms);
    }
    if (e.name === 'verify.verdict' && e.verdict) verifyRaw = e.verdict;
  }

  if (modelCounts.size) {
    run.model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  if (toolLatencies.length) {
    const sorted = toolLatencies.slice().sort((a, b) => a - b);
    run.p50_ms = percentile(sorted, 0.5);
    run.p95_ms = percentile(sorted, 0.95);
    run.p99_ms = percentile(sorted, 0.99);
  }
  run.verify = normalizeVerdict(verifyRaw);
  return run;
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function formatMs(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return String(Math.round(v));
}

function runToRow(run) {
  return [
    run.run_id || '',
    run.started || '',
    run.model || '',
    String(run.input_tokens | 0),
    String(run.output_tokens | 0),
    String(run.cache_read | 0),
    String(run.cache_write | 0),
    String(run.tools | 0),
    String(run.tool_errors | 0),
    formatMs(run.p50_ms),
    formatMs(run.p95_ms),
    formatMs(run.p99_ms),
    run.verify || '-',
  ].map(csvEscape).join(',');
}

export function buildCsv({ home = null } = {}) {
  try {
    const root = resolveHome(home);
    const files = listRecentTraceFiles(root);
    const lines = [CSV_HEADER];
    for (const file of files) {
      try {
        const run = aggregateRun(file);
        lines.push(runToRow(run));
      } catch {
        // skip unreadable / malformed trace file
      }
    }
    return lines.join('\n');
  } catch {
    return CSV_HEADER;
  }
}

function defaultOutPath(home) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(home, 'state', 'exports', `metrics-${ts}.csv`);
}

export function exportCsv({ home = null, outPath = null } = {}) {
  try {
    const root = resolveHome(home);
    const csv = buildCsv({ home: root });
    const path = outPath || defaultOutPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, csv + '\n', 'utf8');
    const lines = csv.split('\n').filter(Boolean);
    const rows = Math.max(0, lines.length - 1);
    return { path, rows };
  } catch (err) {
    return { path: '', rows: 0, error: String(err && err.message ? err.message : err) };
  }
}
