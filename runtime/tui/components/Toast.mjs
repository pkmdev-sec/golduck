/* ─────────────────────────────────────────────────────────────────────────
 * Toast — transient notification with a subtle slide-in.
 * ─────────────────────────────────────────────────────────────────────────
 * When message changes, toast animates in over ~180ms by shrinking its
 * leftMargin (a cheap way to get motion without overdrawing).
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const COLOR_FOR = {
  info: COLORS.primary,
  ok:   COLORS.success,
  warn: COLORS.warning,
  error: COLORS.error,
};
const ICON_FOR = {
  info: GLYPH.dot,
  ok:   GLYPH.check,
  warn: '⚠',
  error: GLYPH.cross,
};

export function Toast({ message, kind = 'info', ttlMs = 2500, onDismiss }) {
  // Keep the latest onDismiss in a ref so we don't retrigger the effect
  // (and restart the dismiss timer + slide-in animation) on every parent
  // render. The animation must run exactly once per unique message.
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);

  const [offset, setOffset] = useState(0); // keep static; animation disabled to avoid flicker
  useEffect(() => {
    if (!message) return undefined;
    const dismiss = setTimeout(() => dismissRef.current?.(), ttlMs);
    return () => clearTimeout(dismiss);
  }, [message, ttlMs]);

  if (!message) return h(Box, null);
  const color = COLOR_FOR[kind] || COLORS.primary;
  const icon = ICON_FOR[kind] || GLYPH.dot;
  return h(Box, {
    borderStyle: 'round',
    borderColor: color,
    paddingX: 1,
    marginLeft: offset,
  },
    h(Text, { color, bold: true }, `${icon}  `),
    h(Text, { color }, message),
  );
}
