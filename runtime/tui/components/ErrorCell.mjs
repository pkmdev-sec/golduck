import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function ErrorCell({ entry }) {
  const msg = String(entry.message || 'error');
  const lines = msg.split('\n');
  return h(Box, {
    flexDirection: 'column',
    marginTop: 1,
    borderStyle: 'round',
    borderColor: COLORS.error,
    paddingX: 1,
  },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { color: COLORS.error, bold: true }, `${GLYPH.cross} error`),
      h(Text, { color: COLORS.textMuted },
        /patch|apply/i.test(entry.message || '') ? 'esc to dismiss · /undo to revert' : 'esc to dismiss',
      ),
    ),
    ...lines.slice(0, 6).map((l, i) =>
      h(Text, { key: i, color: COLORS.error }, l),
    ),
    lines.length > 6 && h(Text, { color: COLORS.textMuted }, `… (+${lines.length - 6} more lines)`),
  );
}
