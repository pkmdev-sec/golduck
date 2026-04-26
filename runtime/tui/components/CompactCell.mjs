import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';

const h = React.createElement;

export function CompactCell({ entry }) {
  return h(Box, { marginLeft: 1, marginTop: 1 },
    h(Text, { color: COLORS.warn }, '⊝ '),
    h(Text, { dimColor: true },
      `compacted transcript${entry.est_tokens ? ` (≈${entry.est_tokens.toLocaleString()} tokens)` : ''}`,
    ),
  );
}
