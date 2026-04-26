/* ─────────────────────────────────────────────────────────────────────────
 * Bench overlay — show latest quality metrics vs a baseline snapshot.
 *
 * Reads ~/.golduck/state/bench/{baseline,latest}.json if present, and
 * renders a diff per metric. Metric direction is inferred from the key:
 * anything that smells like latency or error rate is treated as
 * "lower is better" (so a negative delta is colored green).
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const REFRESH_MS = 2000;

const LOWER_IS_BETTER_SUFFIXES = ['_ms', '_us', '_ns', '_p50', '_p95', '_p99', '_err'];
const LOWER_IS_BETTER_SUBSTRINGS = ['latency', 'error_rate'];

function lowerIsBetter(key) {
  const k = String(key).toLowerCase();
  if (LOWER_IS_BETTER_SUFFIXES.some((s) => k.endsWith(s))) return true;
  if (LOWER_IS_BETTER_SUBSTRINGS.some((s) => k.includes(s))) return true;
  return false;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function loadBench() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const dir = join(HOME, 'state', 'bench');
  const baseline = readJson(join(dir, 'baseline.json'));
  const latest = readJson(join(dir, 'latest.json'));
  return { baseline, latest };
}

function fmtValue(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 10_000) return String(n);
  if (Math.abs(n) >= 1000) return n.toFixed(1);
  if (Math.abs(n) >= 1) return n.toFixed(3);
  return n.toFixed(4);
}

function MetricRow({ name, latest, baseline }) {
  let deltaNode;
  if (typeof baseline !== 'number' || !Number.isFinite(baseline)) {
    deltaNode = h(Text, { dimColor: true }, '(no baseline)');
  } else if (baseline === 0) {
    if (latest === 0) {
      deltaNode = h(Text, { dimColor: true }, '±0.0%');
    } else {
      const diff = latest - baseline;
      const sign = diff > 0 ? '+' : '-';
      const lower = lowerIsBetter(name);
      const better = lower ? diff < 0 : diff > 0;
      deltaNode = h(Text, { color: better ? COLORS.ok : COLORS.error },
        `${sign}${fmtValue(Math.abs(diff))}`);
    }
  } else if (latest === baseline) {
    deltaNode = h(Text, { dimColor: true }, '±0.0%');
  } else {
    const diff = latest - baseline;
    const pct = (diff / Math.abs(baseline)) * 100;
    const sign = diff > 0 ? '+' : '-';
    const lower = lowerIsBetter(name);
    const better = lower ? diff < 0 : diff > 0;
    const color = better ? COLORS.ok : COLORS.error;
    deltaNode = h(Text, { color }, `${sign}${Math.abs(pct).toFixed(1)}%`);
  }

  const latestStr = typeof latest === 'number' && Number.isFinite(latest)
    ? fmtValue(latest)
    : String(latest ?? '—');

  return h(Box, null,
    h(Box, { width: 24 },
      h(Text, { bold: true, wrap: 'truncate-end' }, String(name)),
    ),
    h(Box, { width: 10, justifyContent: 'flex-end' },
      h(Text, null, latestStr),
    ),
    h(Box, { width: 2 }),
    h(Box, { flexGrow: 1 }, deltaNode),
  );
}

export function Bench({ onClose, hasTTY }) {
  const [data, setData] = useState(() => loadBench());

  useEffect(() => {
    const reload = () => { try { setData(loadBench()); } catch { /* swallow */ } };
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useInput((_input, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const title = `${GLYPH.diamond} bench`;
  const footer = `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`;

  if (!data) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true, italic: true }, '(loading…)'),
    );
  }

  const { baseline, latest } = data;

  if (!baseline) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true, italic: true },
        '(no baseline — run `golduck bench snapshot` from CLI to create one)'),
    );
  }

  const latestMetrics = (latest && latest.metrics && typeof latest.metrics === 'object')
    ? latest.metrics
    : {};
  const baselineMetrics = (baseline.metrics && typeof baseline.metrics === 'object')
    ? baseline.metrics
    : {};

  const names = Object.keys(latestMetrics);
  const asOf = baseline.as_of || 'unknown';
  const metricCount = Object.keys(baselineMetrics).length;

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true },
        `· baseline as of ${asOf} · ${metricCount} metrics tracked`),

      h(Box, { marginTop: 1 },
        h(Text, { color: COLORS.brand, bold: true }, 'Baseline'),
      ),
      h(Text, { dimColor: true },
        `  ts=${asOf}  ·  ${metricCount} metric${metricCount === 1 ? '' : 's'}`),

      h(Box, { marginTop: 1 },
        h(Text, { color: COLORS.brand, bold: true }, 'Metrics vs baseline'),
      ),
      names.length === 0
        ? h(Text, { dimColor: true, italic: true }, '  (no metrics in latest snapshot)')
        : h(Box, { flexDirection: 'column' },
            ...names.map((name, i) => h(MetricRow, {
              key: `m${i}`,
              name,
              latest: latestMetrics[name],
              baseline: baselineMetrics[name],
            })),
          ),
    ),
  );
}
