/* PlanCell — chat-stream cell rendering a plan entry with aligned columns. */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';
import { BorderedCard } from './BorderedCard.mjs';

const h = React.createElement;
const MAX_STEPS = 10;

function glyphFor(status, tick = 0) {
  switch (status) {
    case 'running': return { ch: GLYPH.spinner[tick % GLYPH.spinner.length], color: 'cyan', dim: false };
    case 'ok':      return { ch: GLYPH.check,      color: COLORS.ok,    dim: false };
    case 'blocked': return { ch: GLYPH.cross,      color: COLORS.error, dim: false };
    case 'skipped': return { ch: GLYPH.diamond,    color: undefined,    dim: true };
    case 'pending':
    default:        return { ch: GLYPH.dot,        color: undefined,    dim: true };
  }
}

function StepRow({ step, i, tick }) {
  const g = glyphFor(step.status, tick);
  const id = String(step.id || (i + 1));
  const inactive = step.status === 'pending' || step.status === 'skipped';
  return h(Box, null,
    h(Box, { width: 2 },
      h(Text, { color: g.color, dimColor: g.dim }, g.ch),
    ),
    h(Box, { width: 4 },
      h(Text, { dimColor: true }, id.padEnd(4).slice(0, 4)),
    ),
    h(Box, { flexGrow: 1 },
      h(Text, { dimColor: inactive, wrap: 'truncate-end' }, String(step.title || '')),
    ),
  );
}

export function PlanCell({ entry, tick = 0 }) {
  const steps = Array.isArray(entry?.steps) ? entry.steps : [];
  const shown = steps.slice(0, MAX_STEPS);
  const extra = steps.length - shown.length;
  const done = steps.filter((s) => s.status === 'ok').length;
  const running = steps.filter((s) => s.status === 'running').length;
  const badge = steps.length > 0
    ? `${done}/${steps.length} done${running ? ` · ${running} running` : ''}`
    : null;

  return h(Box, { marginTop: 1, marginLeft: 1 },
    h(BorderedCard, {
      title: `⎔ plan`,
      titleColor: COLORS.brand,
      badge,
    },
      entry?.goal ? h(Text, { dimColor: true }, `goal  ${entry.goal}`) : null,
      ...shown.map((step, i) => h(StepRow, { key: i, step, i, tick })),
      extra > 0 ? h(Text, { dimColor: true }, `+${extra} more`) : null,
    ),
  );
}
