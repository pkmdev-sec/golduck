/* ─────────────────────────────────────────────────────────────────────────
 * EmptyState — the one canonical "nothing here yet" row shared by every
 * overlay. Dim italic text with an optional glyph + hint line beneath.
 *
 * Use:
 *   h(EmptyState, {
 *     message: 'no sessions saved yet',
 *     hint: 'every turn auto-saves; try /save',
 *   })
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function EmptyState({ message, hint, glyph = GLYPH.diamond }) {
  return h(Box, { flexDirection: 'column', paddingY: 1 },
    h(Box, null,
      h(Text, { dimColor: true, italic: true }, `${glyph}  ${message}`),
    ),
    hint ? h(Box, { marginTop: 0 },
      h(Text, { dimColor: true }, `   ${hint}`),
    ) : null,
  );
}
