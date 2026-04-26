/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI / Badge — tiny inline pill for status tags
 * ─────────────────────────────────────────────────────────────────────────
 * Usage:
 *   h(Badge, { text: 'ok', tone: 'ok' })        // [ok]  (green, bold)
 *   h(Badge, { text: 'cached', tone: 'dim' })   // [cached] (dim)
 *
 * Tones map to ink's named colors; `dim` omits the color and relies on
 * dimColor so it inherits the surrounding foreground.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Text } from 'ink';

const h = React.createElement;

const TONE_COLOR = {
  ok:    'green',
  warn:  'yellow',
  error: 'red',
  info:  'cyan',
  dim:   undefined,
};

export function Badge({ text, tone = 'dim' }) {
  const color = TONE_COLOR[tone];
  const dimColor = tone === 'dim';
  return h(Text, { color, dimColor, bold: tone !== 'dim' }, `[${text}]`);
}
