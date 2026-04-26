/* ─────────────────────────────────────────────────────────────────────────
 * Dag overlay — declared DAGs (from $GOLDUCK_HOME/dags) + active DAG run.
 * ─────────────────────────────────────────────────────────────────────────
 * Two-section layout separated by a dim divider. Left column is fixed-width
 * so the file / step ids align. Running step gets a spinner.
 * Polls every 1500ms. Parent handles esc.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { statSync } from 'node:fs';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';
import { listDags, readDagStatus } from '../dag_reader.mjs';

const h = React.createElement;
const REFRESH_MS = 1500;

function ageStr(mtimeMs) {
  if (!mtimeMs) return '';
  const d = Math.max(0, Date.now() - mtimeMs);
  const s = Math.floor(d / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24)  return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  return `${day}d ago`;
}

function sizeStr(path) {
  try {
    const n = statSync(path).size || 0;
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  } catch { return ''; }
}

function fileName(d) {
  // dag_reader strips the extension from name; rebuild the display name
  // from the path basename so users see e.g. `build-release.json`.
  try {
    const p = String(d.path || '');
    const slash = p.lastIndexOf('/');
    return slash >= 0 ? p.slice(slash + 1) : (d.name || '');
  } catch { return d.name || ''; }
}

function glyphFor(status, tick) {
  switch (status) {
    case 'running': return { ch: GLYPH.spinner[tick % GLYPH.spinner.length], color: COLORS.tool, dim: false };
    case 'ok':
    case 'done':    return { ch: GLYPH.check,   color: COLORS.ok,    dim: false };
    case 'blocked':
    case 'failed':  return { ch: GLYPH.cross,   color: COLORS.error, dim: false };
    case 'skipped': return { ch: GLYPH.diamond, color: undefined,    dim: true };
    case 'pending':
    default:        return { ch: GLYPH.dot,     color: undefined,    dim: true };
  }
}

function countStatuses(steps) {
  const acc = { pending: 0, running: 0, done: 0, blocked: 0, skipped: 0 };
  for (const s of steps) {
    const st = s?.status;
    if (st === 'ok' || st === 'done')              acc.done += 1;
    else if (st === 'running')                     acc.running += 1;
    else if (st === 'blocked' || st === 'failed')  acc.blocked += 1;
    else if (st === 'skipped')                     acc.skipped += 1;
    else                                           acc.pending += 1;
  }
  return acc;
}

function DagFileRow({ d }) {
  return h(Box, null,
    h(Box, { width: 3 }, h(Text, { dimColor: true }, GLYPH.arrow)),
    h(Box, { width: 28 }, h(Text, { wrap: 'truncate-end' }, fileName(d))),
    h(Box, { width: 8 }, h(Text, { dimColor: true }, sizeStr(d.path))),
    h(Box, { flexGrow: 1 }, h(Text, { dimColor: true }, ageStr(d.mtime))),
  );
}

function StepRow({ step, tick }) {
  const g = glyphFor(step.status, tick);
  const id = String(step.id || '').slice(0, 8);
  return h(Box, null,
    h(Box, { width: 3 }, h(Text, { color: g.color, dimColor: g.dim }, g.ch)),
    h(Box, { width: 10 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, id)),
    h(Box, { flexGrow: 1 },
      h(Text, { wrap: 'truncate-end', bold: step.status === 'running' }, String(step.title || '')),
    ),
    step.notes
      ? h(Box, { width: 24 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, String(step.notes)))
      : null,
  );
}

export function Dag({ onClose, hasTTY }) {
  const [dags, setDags]     = useState(() => listDags());
  const [status, setStatus] = useState(() => readDagStatus());
  const [tick, setTick]     = useState(0);

  useEffect(() => {
    const poll = setInterval(() => {
      setDags(listDags());
      setStatus(readDagStatus());
    }, REFRESH_MS);
    const spin = setInterval(() => setTick((t) => t + 1), 100);
    return () => { clearInterval(poll); clearInterval(spin); };
  }, []);

  useInput((_ch, key) => { if (key.escape) onClose?.(); }, { isActive: Boolean(hasTTY) });

  const steps = Array.isArray(status.steps) ? status.steps : [];
  const counts = countStatuses(steps);
  const chipParts = [];
  if (status.run_id) chipParts.push(`run ${String(status.run_id).slice(0, 10)}`);
  if (steps.length) {
    chipParts.push(`${counts.done}/${steps.length} done`);
    if (counts.running) chipParts.push(`${counts.running} running`);
    if (counts.blocked) chipParts.push(`${counts.blocked} blocked`);
  }
  const title = chipParts.length
    ? `${GLYPH.diamond} dag · ${chipParts.join(' · ')}`
    : `${GLYPH.diamond} dag`;

  return h(OverlayFrame, {
    title,
    footer: `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`,
  },
    h(Text, { color: COLORS.brand, bold: true }, 'available dags'),
    dags.length === 0
      ? h(Text, { dimColor: true, italic: true }, '   (no DAGs in $GOLDUCK_HOME/dags/)')
      : h(Box, { flexDirection: 'column' },
          ...dags.slice(0, 8).map((d, i) => h(DagFileRow, { key: `d${i}`, d })),
        ),
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, GLYPH.divider.repeat(48)),
    ),
    h(Box, { marginTop: 1 },
      h(Text, { color: COLORS.brand, bold: true }, 'active run'),
    ),
    steps.length === 0
      ? h(Text, { dimColor: true, italic: true },
          '   (no active DAG — run `golduck dag <name>` or `/dag <name>`)')
      : h(Box, { flexDirection: 'column' },
          ...steps.map((step, i) => h(StepRow, { key: `s${i}`, step, tick })),
        ),
  );
}
