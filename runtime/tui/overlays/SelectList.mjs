/* Reusable list-with-arrow-keys component. */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

export function SelectList({ items, onSelect, onClose, renderItem, hasTTY = true }) {
  const [idx, setIdx] = useState(0);
  useInput((ch, key) => {
    if (key.upArrow)      setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(items.length - 1, i + 1));
    else if (key.return) { if (items[idx]) onSelect?.(items[idx], idx); }
    else if (key.escape) { onClose?.(); }
  }, { isActive: Boolean(hasTTY) });

  return h(Box, { flexDirection: 'column' },
    items.length === 0
      ? h(Text, { dimColor: true }, '(empty)')
      : items.map((item, i) =>
          h(Box, { key: i },
            h(Text, { color: i === idx ? COLORS.brand : undefined, bold: i === idx },
              `${i === idx ? GLYPH.playhead : ' '} `,
            ),
            renderItem ? renderItem(item, i === idx) : h(Text, null, String(item)),
          ),
        ),
  );
}
