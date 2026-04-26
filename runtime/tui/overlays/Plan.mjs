/* ─────────────────────────────────────────────────────────────────────────
 * Plan overlay — current DAG / todo list from $GOLDUCK_HOME/state/plan.json.
 * Fixed-column rows, animated spinner on running steps, summary chip in title.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;
const REFRESH_MS = 1500;

function loadPlan() {
  const f = join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'state', 'plan.json');
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; } catch { return null; }
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
    if (st === 'ok' || st === 'done')           acc.done += 1;
    else if (st === 'running')                  acc.running += 1;
    else if (st === 'blocked' || st === 'failed') acc.blocked += 1;
    else if (st === 'skipped')                  acc.skipped += 1;
    else                                        acc.pending += 1;
  }
  return acc;
}

function summaryChip(c) {
  const parts = [`${c.done + c.running + c.pending + c.blocked + c.skipped} steps`];
  if (c.done)    parts.push(`${c.done} done`);
  if (c.running) parts.push(`${c.running} running`);
  if (c.pending) parts.push(`${c.pending} pending`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  return parts.join(' · ');
}

function Row({ step, tick }) {
  const g = glyphFor(step.status, tick);
  const id = String(step.id || '').slice(0, 4);
  const title = String(step.title || '');
  const notes = step.notes ? String(step.notes) : '';
  return h(Box, null,
    h(Box, { width: 3 },
      h(Text, { color: g.color, dimColor: g.dim }, g.ch),
    ),
    h(Box, { width: 5 },
      h(Text, { dimColor: true }, id),
    ),
    h(Box, { flexGrow: 1 },
      h(Text, { wrap: 'truncate-end', bold: step.status === 'running' }, title),
    ),
    notes
      ? h(Box, { width: 30 },
          h(Text, { dimColor: true, wrap: 'truncate-end' }, notes),
        )
      : null,
  );
}

export function Plan({ onClose, hasTTY }) {
  const [plan, setPlan] = useState(() => loadPlan());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const poll = setInterval(() => setPlan(loadPlan()), REFRESH_MS);
    const spin = setInterval(() => setTick((t) => t + 1), 100);
    return () => { clearInterval(poll); clearInterval(spin); };
  }, []);

  useInput((_ch, key) => { if (key.escape) onClose?.(); }, { isActive: Boolean(hasTTY) });

  if (!plan) {
    return h(OverlayFrame, {
      title: `${GLYPH.diamond} plan`,
      footer: `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`,
    },
      h(Text, { dimColor: true, italic: true }, '(no active plan — run `/plan <goal>` to decompose)'),
    );
  }

  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const counts = countStatuses(steps);
  const title  = `${GLYPH.chevron} plan · ${summaryChip(counts)}`;

  return h(OverlayFrame, {
    title,
    footer: `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`,
  },
    h(Box, null,
      h(Box, { width: 8 }, h(Text, { dimColor: true }, 'goal')),
      h(Box, { flexGrow: 1 }, h(Text, { bold: true, wrap: 'truncate-end' }, String(plan.goal || '(unnamed)'))),
    ),
    steps.length === 0
      ? h(Box, { marginTop: 1 },
          h(Text, { dimColor: true, italic: true }, '(plan has no steps yet)'),
        )
      : h(Box, { flexDirection: 'column', marginTop: 1 },
          ...steps.map((step, i) => h(Row, { key: `s${i}`, step, tick })),
        ),
  );
}
