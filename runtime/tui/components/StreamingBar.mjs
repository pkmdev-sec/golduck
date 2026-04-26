/* ─────────────────────────────────────────────────────────────────────────
 * StreamingBar — single quiet row rendered while the assistant is
 * streaming. No sine wave, no sparkline, no per-tick reflow — just a
 * static label + token count + elapsed + hint. Coarse bucketing ensures
 * this row re-paints at most ~twice a second.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';

const h = React.createElement;

export function StreamingBar({ visible, elapsedMs, tokens, label = 'streaming' }) {
  if (!visible) return h(Box, null);
  if ((tokens || 0) === 0 && (elapsedMs || 0) < 400) return h(Box, null);
  const secs = Math.max(0, Math.floor((elapsedMs || 0) / 1000));
  const tokStr = `${tokens || 0} tok`;
  const elapsedStr = `${secs}s`;

  return h(Box, { paddingX: 1 },
    h(Text, { color: COLORS.primary, bold: true }, `· ${label}`),
    h(Text, { color: COLORS.textMuted }, '  ·  '),
    h(Text, { color: COLORS.textPrimary }, tokStr),
    h(Text, { color: COLORS.textMuted }, '  ·  '),
    h(Text, { color: COLORS.textSecondary }, elapsedStr),
    h(Text, { color: COLORS.textMuted }, '   esc to cancel'),
  );
}
