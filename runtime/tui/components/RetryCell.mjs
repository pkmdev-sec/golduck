/* ─────────────────────────────────────────────────────────────────────────
 * RetryCell — single dim line signalling a retry attempt. Rendered inline
 * with the transcript so operators can tell when the engine is backing off.
 * Pattern mirrors CompactCell: one Box, two-ish spans of Text.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';

const h = React.createElement;

export function RetryCell({ entry }) {
  const attempt = (entry && entry.attempt != null) ? entry.attempt : '?';
  const waitMs  = (entry && entry.wait_ms != null) ? entry.wait_ms : '?';
  const reason  = (entry && entry.reason) ? String(entry.reason) : 'unknown';
  // Spec sample uses the "↻" reload glyph literal.
  const glyph   = '↻';

  return h(Box, { marginLeft: 1, marginTop: 1 },
    h(Text, { color: COLORS.warn }, ` ${glyph} retry #${attempt}`),
    h(Text, { dimColor: true }, `  (wait ${waitMs}ms)  — ${reason}`),
  );
}
