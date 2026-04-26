import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function ThinkingCell({ entry }) {
  const preview = String(entry.preview || '').replace(/\s+/g, ' ');
  const trimmed = preview.length > 120 ? preview.slice(0, 120) + GLYPH.ellipsis : preview;
  return h(Box, { marginTop: 1, marginLeft: 1 },
    h(Text, { color: COLORS.textMuted, italic: true },
      `${GLYPH.diamond} thought  `),
    h(Text, { color: COLORS.textMuted }, `${entry.lines}L · ${entry.chars}c  `),
    h(Text, { color: COLORS.textMuted, italic: true }, trimmed),
  );
}
