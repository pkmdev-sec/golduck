/* ─────────────────────────────────────────────────────────────────────────
 * OverlayFrame — bordered floating panel used by all overlays.
 * Centers via ink's flexbox. Pressing esc closes.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function OverlayFrame({ title, children, footer = 'esc to close' }) {
  const width = Math.min(process.stdout.columns || 80, 100);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: COLORS.brand, paddingX: 2, paddingY: 1, width },
    h(Box, { justifyContent: 'space-between' },
      h(Text, { color: COLORS.brand, bold: true }, title),
      h(Text, { dimColor: true }, footer),
    ),
    h(Box, { marginTop: 1, flexDirection: 'column' }, children),
  );
}
