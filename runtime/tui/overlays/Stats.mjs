/* ─────────────────────────────────────────────────────────────────────────
 * Stats overlay — aggregate metrics across the most recent trace files.
 * Layout uses fixed-width Box columns so numbers line up cleanly.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;
const REFRESH_MS = 3000;

function human(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function loadStats() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const TRACES = join(HOME, 'traces');
  if (!existsSync(TRACES)) return { perRun: [], totals: null, cost: null };

  let files = [];
  try {
    files = readdirSync(TRACES)
      .filter((f) => f.endsWith('.jsonl') && f !== 'current.jsonl')
      .map((f) => join(TRACES, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, 20);
  } catch { files = []; }

  const perRun = [];
  for (const f of files) {
    const evs = readEvents(f);
    const run = {
      file: f, run_id: null, started: null, ended: null,
      input: 0, output: 0, cache_read: 0, cache_write: 0,
      tools: 0, tool_errors: 0, tool_latencies: [],
      verify: null, verify_pass: 0, verify_revise: 0,
    };
    for (const e of evs) {
      run.run_id = run.run_id || e.run_id;
      if (e.name === 'trace.open') run.started = e.ts;
      if (e.name === 'trace.close') run.ended = e.ts;
      if (e.name === 'engine.response' && e.usage) {
        run.input += e.usage.input_tokens || 0;
        run.output += e.usage.output_tokens || 0;
        run.cache_read += e.usage.cache_read_input_tokens || 0;
        run.cache_write += e.usage.cache_creation_input_tokens || 0;
      }
      if (e.span === 'tool.call' && e.name !== 'span.exit') run.tools++;
      if (e.name === 'span.exit' && e.span === 'tool.call') {
        if (e.ok === false) run.tool_errors++;
        if (typeof e.duration_ms === 'number') run.tool_latencies.push(e.duration_ms);
      }
      if (e.name === 'verify.verdict') {
        run.verify = e.verdict;
        if (e.verdict === 'pass') run.verify_pass++;
        else if (e.verdict === 'revise') run.verify_revise++;
      }
    }
    perRun.push(run);
  }

  const totals = perRun.reduce((a, r) => ({
    runs: a.runs + 1,
    input: a.input + r.input, output: a.output + r.output,
    cache_read: a.cache_read + r.cache_read, cache_write: a.cache_write + r.cache_write,
    tools: a.tools + r.tools, tool_errors: a.tool_errors + r.tool_errors,
    tool_latencies: a.tool_latencies.concat(r.tool_latencies),
    verify_pass: a.verify_pass + r.verify_pass,
    verify_revise: a.verify_revise + r.verify_revise,
  }), {
    runs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0,
    tools: 0, tool_errors: 0, tool_latencies: [], verify_pass: 0, verify_revise: 0,
  });

  totals.usd = (totals.input * 15 + totals.output * 75 + totals.cache_read * 1.5 + totals.cache_write * 18.75) / 1_000_000;
  if (totals.tool_latencies.length) {
    const ls = totals.tool_latencies.slice().sort((a, b) => a - b);
    const pct = (p) => ls[Math.min(Math.floor(ls.length * p), ls.length - 1)];
    totals.p50 = pct(0.5);
    totals.p95 = pct(0.95);
    totals.p99 = pct(0.99);
    totals.max = ls[ls.length - 1];
  }

  let cost = null;
  const costFile = join(HOME, 'memory', 'cost.json');
  if (existsSync(costFile)) {
    try { cost = JSON.parse(readFileSync(costFile, 'utf8')); } catch { cost = null; }
  }

  return { perRun, totals, cost };
}

function TotalRow({ label, value }) {
  return h(Box, null,
    h(Box, { width: 4 }, h(Text, null, '    ')),
    h(Box, { width: 16 }, h(Text, { dimColor: true }, label)),
    h(Text, { bold: true }, value),
  );
}

function SectionHeader({ children }) {
  return h(Box, null,
    h(Box, { width: 2 }, h(Text, null, '  ')),
    h(Text, { color: COLORS.brand, bold: true }, children),
  );
}

export function Stats({ onClose, hasTTY }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const reload = () => { if (!cancelled) setData(loadStats()); };
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const runsLabel = data?.totals?.runs ?? '…';
  const title = `◇ stats · last ${runsLabel} runs`;
  const footer = 'esc to close · refresh=3s';

  if (!data) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true, italic: true }, '  (loading…)'),
    );
  }

  const { perRun, totals, cost } = data;
  if (!totals || totals.runs === 0) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true, italic: true }, '  (no traces yet — run a turn to populate stats)'),
    );
  }

  const totalsRows = [
    { label: 'runs',          value: String(totals.runs) },
    { label: 'input tokens',  value: human(totals.input) },
    { label: 'output tokens', value: human(totals.output) },
    { label: 'cache hit',     value: human(totals.cache_read) },
    { label: 'cache write',   value: human(totals.cache_write) },
    { label: 'tool calls',    value: String(totals.tools) },
    { label: 'tool errors',   value: String(totals.tool_errors) },
    { label: 'verify pass',   value: String(totals.verify_pass) },
    { label: 'verify revise', value: String(totals.verify_revise) },
    { label: 'spend',         value: `$${totals.usd.toFixed(4)}` },
  ];
  if (cost) {
    if (typeof cost.session_usd === 'number')
      totalsRows.push({ label: 'session $',  value: `$${Number(cost.session_usd).toFixed(4)}` });
    if (typeof cost.lifetime_usd === 'number')
      totalsRows.push({ label: 'lifetime $', value: `$${Number(cost.lifetime_usd).toFixed(4)}` });
  }

  const hasLatency = typeof totals.p50 === 'number';
  const recent = perRun.slice(0, 10);

  return h(OverlayFrame, { title, footer },
    h(SectionHeader, null, 'Totals'),
    h(Box, { flexDirection: 'column', marginBottom: 1 },
      ...totalsRows.map((r, i) => h(TotalRow, { key: `t${i}`, label: r.label, value: r.value })),
    ),

    hasLatency && h(React.Fragment, null,
      h(SectionHeader, null, 'Latency (ms)'),
      h(Box, null,
        h(Box, { width: 4 }, h(Text, null, '    ')),
        h(Box, { width: 6 }, h(Text, { dimColor: true }, 'p50')),
        h(Box, { width: 6 }, h(Text, { dimColor: true }, 'p95')),
        h(Box, { width: 6 }, h(Text, { dimColor: true }, 'p99')),
        h(Box, { width: 6 }, h(Text, { dimColor: true }, 'max')),
      ),
      h(Box, { marginBottom: 1 },
        h(Box, { width: 4 }, h(Text, null, '    ')),
        h(Box, { width: 6 }, h(Text, { bold: true }, String(totals.p50))),
        h(Box, { width: 6 }, h(Text, { bold: true }, String(totals.p95))),
        h(Box, { width: 6 }, h(Text, { bold: true }, String(totals.p99))),
        h(Box, { width: 6 }, h(Text, { bold: true }, String(totals.max))),
      ),
    ),

    h(SectionHeader, null, 'Recent runs'),
    recent.length === 0
      ? h(Text, { dimColor: true, italic: true }, '    (no recent runs)')
      : h(Box, { flexDirection: 'column' },
          ...recent.map((r, i) => {
            const tokens = (r.input + r.output + r.cache_read + r.cache_write) || 0;
            const started = (r.started || '-').replace('T', ' ').slice(11, 19) || '--:--:--';
            const id = (r.run_id || '?').slice(0, 8);
            return h(Box, { key: `r${i}` },
              h(Box, { width: 4 }, h(Text, null, '    ')),
              h(Box, { width: 10 }, h(Text, { bold: true }, id)),
              h(Box, { width: 10 }, h(Text, { dimColor: true }, started)),
              h(Box, { width: 14 }, h(Text, null, `${human(tokens)} tokens`)),
              h(Box, { width: 18 }, h(Text, { dimColor: true }, `verify=${r.verify || '-'}`)),
              h(Box, { width: 10 }, h(Text, { dimColor: true }, `${r.tools} tools`)),
            );
          }),
        ),
  );
}
