/* ─────────────────────────────────────────────────────────────────────────
 * Collapsible — stateless long-cell wrapper for golduck's TUI.
 * ─────────────────────────────────────────────────────────────────────────
 * The parent owns the `expanded` flag; this component is pure render.
 * `onToggle` is reserved for a future parent-owned key handler.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function Collapsible({ text, maxLines = 40, expanded = false, language = null, onToggle }) {
  const body = typeof text === 'string' ? text : String(text ?? '');
  const lines = body.split('\n');
  const isCode = typeof language === 'string';
  const textColor = isCode ? COLORS.tool : undefined;

  // Short enough to render verbatim — ignore `expanded`.
  if (lines.length <= maxLines) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { wrap: 'wrap', color: textColor }, body),
    );
  }

  if (!expanded) {
    const visibleCount = maxLines - 2;
    const shown = lines.slice(0, visibleCount).join('\n');
    const hint = 'enter on this row to expand';
    return h(Box, { flexDirection: 'column' },
      h(Text, { wrap: 'wrap', color: textColor }, shown),
      h(Text, { dimColor: true },
        `${GLYPH.arrow} expand (showing ${visibleCount}/${lines.length} lines — hit ${hint})${GLYPH.ellipsis}`,
      ),
    );
  }

  return h(Box, { flexDirection: 'column' },
    h(Text, { wrap: 'wrap', color: textColor }, body),
    h(Text, { dimColor: true }, `▾ collapse (${lines.length} lines)`),
  );
}
