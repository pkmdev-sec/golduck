/* ─────────────────────────────────────────────────────────────────────────
 * BorderedCard — the one canonical card renderer used by every overlay /
 * cell that needs a framed box.
 * ─────────────────────────────────────────────────────────────────────────
 * Gives a consistent look:
 *   - rounded corners everywhere
 *   - title floats on the top-border, colored
 *   - optional badge on the right (e.g. "approved", "3 tools")
 *   - left-padding 1, no top/bottom padding (callers add marginTop/Bottom)
 *
 * Call:
 *   h(BorderedCard, {
 *     title: 'handoff',
 *     titleColor: COLORS.brand,
 *     badge: '3 tools',
 *     badgeColor: COLORS.ok,
 *   }, ...children)
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS } from '../theme.mjs';

const h = React.createElement;

export function BorderedCard({
  title = null,
  titleColor = COLORS.brand,
  badge = null,
  badgeColor = undefined,
  borderColor = COLORS.border,
  children,
}) {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor,
    paddingX: 1,
  },
    (title || badge) && h(Box, { justifyContent: 'space-between' },
      h(Text, { color: titleColor, bold: true }, title || ''),
      badge ? h(Text, { color: badgeColor, dimColor: !badgeColor }, ' ' + badge) : null,
    ),
    children,
  );
}
