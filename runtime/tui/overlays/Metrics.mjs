/* ─────────────────────────────────────────────────────────────────────────
 * Metrics overlay — latency + think/output ratios across recent runs.
 * Re-reads the most recent 20 trace .jsonl files every 2000ms and renders
 * three labeled sections (TTFT, Tool latency, Thinking ratio) with
 * p50/p95/p99 and an 8-slot unicode sparkline each.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const MAX_FILES = 20;

function sparkline(values, slots = 8) {
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const blocks = ' ▁▂▃▄▅▆▇█';
  const step = Math.max(1, Math.ceil(values.length / slots));
  const out = [];
  for (let i = 0; i < values.length; i += step) {
    const chunk = values.slice(i, i + step);
    const avg = chunk.reduce((a, b) => a + b, 0) / chunk.length;
    const idx = Math.min(blocks.length - 1, Math.max(0, Math.floor(((avg - min) / range) * (blocks.length - 1))));
    out.push(blocks[idx]);
  }
  return out.join('');
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(Math.floor(sortedAsc.length * p), sortedAsc.length - 1);
  return sortedAsc[idx];
}

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function listRecentTraceFiles() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const TRACES = join(HOME, 'traces');
  if (!existsSync(TRACES)) return [];
  let entries = [];
  try { entries = readdirSync(TRACES); } catch { entries = []; }
  const resolved = new Set();
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    let p = join(TRACES, f);
    if (f === 'current.jsonl') {
      try { p = realpathSync(p); } catch { /* keep */ }
    }
    resolved.add(p);
  }
  return [...resolved].filter((p) => {
    try { return statSync(p).isFile(); } catch { return false; }
  }).sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  }).slice(0, MAX_FILES);
}

function loadMetrics() {
  const files = listRecentTraceFiles();
  const ttft = [];          // ms per request/response pair
  const toolLatency = [];   // ms per tool.call span.exit
  const thinkingRatio = []; // per-file thinking_chars / output_chars
  const perModel = new Map();
  const timestamps = [];

  for (const file of files) {
    const evs = readEvents(file);
    let pendingRequest = null;
    let fileThinkChars = 0;
    let fileOutputChars = 0;
    let sawAny = false;
    for (const ev of evs) {
      if (ev.ts) { timestamps.push(ev.ts); sawAny = true; }
      if (ev.name === 'engine.request') {
        pendingRequest = ev;
      } else if (ev.name === 'engine.response') {
        if (pendingRequest && pendingRequest.ts && ev.ts) {
          const dt = new Date(ev.ts).getTime() - new Date(pendingRequest.ts).getTime();
          if (Number.isFinite(dt) && dt >= 0) ttft.push(dt);
        }
        pendingRequest = null;
        const model = ev.model || 'unknown';
        perModel.set(model, (perModel.get(model) || 0) + 1);
        const outTok = (ev.usage && ev.usage.output_tokens) || 0;
        fileOutputChars += outTok * 4;
      } else if (ev.name === 'engine.thinking') {
        if (typeof ev.chars === 'number') fileThinkChars += ev.chars;
        else if (typeof ev.text === 'string') fileThinkChars += ev.text.length;
        else if (ev.usage && typeof ev.usage.thinking_tokens === 'number') fileThinkChars += ev.usage.thinking_tokens * 4;
      } else if (ev.name === 'span.exit' && ev.span === 'tool.call' && typeof ev.duration_ms === 'number') {
        toolLatency.push(ev.duration_ms);
      }
    }
    if (sawAny && fileOutputChars > 0) {
      thinkingRatio.push(fileThinkChars / fileOutputChars);
    }
  }

  timestamps.sort();
  const oldest = timestamps[0] || null;
  const newest = timestamps[timestamps.length - 1] || null;

  const summarize = (values) => {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    return {
      count: values.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      spark: sparkline(values),
    };
  };

  return {
    runs: files.length,
    ttft: summarize(ttft),
    toolLatency: summarize(toolLatency),
    thinkingRatio: summarize(thinkingRatio),
    perModel: [...perModel.entries()].sort((a, b) => b[1] - a[1]),
    oldest, newest,
  };
}

function fmtMs(v) {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${Math.round(v)}ms`;
}

function fmtRatio(v) {
  if (v == null) return '—';
  return v.toFixed(2);
}

function Section({ label, stats, formatter }) {
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Text, { color: COLORS.brand, bold: true }, label),
    stats
      ? h(Box, { flexDirection: 'column' },
          h(Box, null,
            h(Box, { width: 2 }, h(Text, null, ' ')),
            h(Box, { width: 18 },
              h(Text, null,
                h(Text, { dimColor: true }, 'p50 '),
                h(Text, null, formatter(stats.p50)),
              ),
            ),
            h(Box, { width: 18 },
              h(Text, null,
                h(Text, { dimColor: true }, 'p95 '),
                h(Text, null, formatter(stats.p95)),
              ),
            ),
            h(Box, { width: 18 },
              h(Text, null,
                h(Text, { dimColor: true }, 'p99 '),
                h(Text, null, formatter(stats.p99)),
              ),
            ),
            h(Box, { flexGrow: 1 },
              h(Text, { dimColor: true }, `n=${stats.count}`),
            ),
          ),
          h(Box, null,
            h(Box, { width: 2 }, h(Text, null, ' ')),
            h(Text, { color: COLORS.tool }, stats.spark || ' '),
          ),
        )
      : h(Box, null,
          h(Box, { width: 2 }, h(Text, null, ' ')),
          h(Text, { dimColor: true, italic: true }, '(no samples)'),
        ),
  );
}

export function Metrics({ onClose, hasTTY }) {
  const [data, setData] = useState(() => loadMetrics());

  useEffect(() => {
    const reload = () => {
      try { setData(loadMetrics()); } catch { /* swallow */ }
    };
    reload();
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, []);

  useInput((_ch, key) => { if (key.escape) onClose?.(); }, { isActive: Boolean(hasTTY) });

  const d = data || { runs: 0, ttft: null, toolLatency: null, thinkingRatio: null, perModel: [], oldest: null, newest: null };

  const samples = (d.ttft?.count || 0) + (d.toolLatency?.count || 0) + (d.thinkingRatio?.count || 0);
  const chip = samples > 0
    ? `${d.runs} runs · ${samples} samples`
    : `${d.runs} runs`;
  const title = `${GLYPH.diamond} metrics · ${chip}`;

  const oldest = (d.oldest || '').replace('T', ' ').slice(0, 19) || '—';
  const newest = (d.newest || '').replace('T', ' ').slice(0, 19) || '—';

  const hasAny = d.ttft || d.toolLatency || d.thinkingRatio;

  return h(OverlayFrame, { title, footer: 'esc to close · refresh=2s' },
    hasAny
      ? h(Box, { flexDirection: 'column' },
          h(Section, { label: 'TTFT',           stats: d.ttft,          formatter: fmtMs }),
          h(Section, { label: 'Tool latency',   stats: d.toolLatency,   formatter: fmtMs }),
          h(Section, { label: 'Thinking ratio', stats: d.thinkingRatio, formatter: fmtRatio }),
          d.perModel.length
            ? h(Box, { flexDirection: 'column', marginTop: 1 },
                h(Text, { color: COLORS.brand, bold: true }, 'requests / model'),
                ...d.perModel.map(([m, c], i) => h(Box, { key: `m${i}` },
                  h(Box, { width: 2 }, h(Text, null, ' ')),
                  h(Box, { width: 30 }, h(Text, { wrap: 'truncate-end' }, String(m))),
                  h(Box, { flexGrow: 1 }, h(Text, { bold: true }, String(c))),
                )),
              )
            : null,
          h(Box, { marginTop: 1 },
            h(Text, { dimColor: true }, `aggregated over ${d.runs} runs · ${oldest} → ${newest}`),
          ),
        )
      : h(Text, { dimColor: true, italic: true },
          '(no trace samples yet — run a turn to start emitting metrics)'),
  );
}
