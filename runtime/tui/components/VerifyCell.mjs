import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const ICON = {
  approve:   GLYPH.check,
  revise:    '↻',
  regressed: GLYPH.cross,
  error:     GLYPH.cross,
};

const LABEL = {
  approve:   'approved',
  revise:    'revise',
  regressed: 'regressed',
  error:     'error',
};

/**
 * Clean verify row with a bordered left gutter that picks up the semantic
 * color so the row visually "belongs" to either the ok, warn, or error family.
 *
 *   ▎ ✓ verify  approved  94%
 *   │   • issue one (if any)
 */
export function VerifyCell({ entry }) {
  const v = entry.verdict;
  const color = v === 'approve' ? COLORS.success
    : v === 'revise' ? COLORS.warning
    : v === 'regressed' || v === 'error' ? COLORS.error
    : COLORS.textMuted;
  const icon = ICON[v] || GLYPH.square;
  const label = LABEL[v] || String(v || 'unknown');
  const conf = entry.confidence != null ? `${Math.round(entry.confidence * 100)}%` : null;
  const issues = entry.issues || [];

  return h(Box, {
    flexDirection: 'column',
    marginTop: 1,
    borderStyle: 'single',
    borderLeft: true,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderColor: color,
    paddingLeft: 1,
  },
    h(Box, null,
      h(Text, { color, bold: true }, `${icon} verify  `),
      h(Text, { color, bold: true }, label),
      conf && h(Text, { color: COLORS.textMuted }, `  ${conf}`),
    ),
    issues.length > 0 && h(Box, { flexDirection: 'column' },
      ...issues.slice(0, 3).map((it, i) => h(Box, { key: i },
        h(Text, { color }, `${GLYPH.bullet} `),
        h(Text, { color: COLORS.textMuted }, String(it).slice(0, 140)),
      )),
    ),
  );
}
