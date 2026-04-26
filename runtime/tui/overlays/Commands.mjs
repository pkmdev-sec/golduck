/* ─────────────────────────────────────────────────────────────────────────
 * Commands palette — floating searchable command picker.
 * ─────────────────────────────────────────────────────────────────────────
 * Layout:
 *   ╭── commands  17 / 42 match "/re"            ↑↓ ⏎ esc ──╮
 *   │                                                       │
 *   │ ▸ /reset         clear conversation                   │
 *   │   /reflect       browse lessons                       │
 *   │   /resume        resume a prior session               │
 *   │   /recall        search cross-session memory          │
 *   │                                                       │
 *   ╰───────────────────────────────────────────────────────╯
 *
 * Key actions:
 *   ↑↓   — navigate
 *   ⏎    — insert selected command into composer
 *   esc  — close palette
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { filterCommands } from '../commands.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const MAX_ROWS = 10;

export function Commands({ query, onChoose, onClose, hasTTY }) {
  const q = query || '/';
  const all = filterCommands('/');
  const items = filterCommands(q);
  const [idx, setIdx] = useState(0);

  // Keep selection valid when filter shrinks.
  useEffect(() => { if (idx >= items.length) setIdx(0); }, [items.length, idx]);

  useInput((ch, key) => {
    if (key.upArrow)         setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow)  setIdx((i) => Math.min(items.length - 1, i + 1));
    else if (key.return) { if (items[idx]) onChoose?.(items[idx]); }
    else if (key.escape)     onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const windowStart = Math.max(0, Math.min(idx - 3, items.length - MAX_ROWS));
  const windowed = items.slice(windowStart, windowStart + MAX_ROWS);

  const title = `commands`;
  const rightCaption = `${items.length} / ${all.length}`;
  const subtitle = q && q !== '/' ? `match "${q}"` : 'type to filter';

  const cols = Math.min(
    Math.max(56, process.stdout.columns || 80),
    process.stdout.columns || parseInt(process.env.COLUMNS || '100', 10),
  );
  const width = Math.min(80, cols - 4);

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: COLORS.brand,
    paddingX: 1,
    width,
  },
    // Header row: title (bold brand) + filter caption + right counts.
    h(Box, { justifyContent: 'space-between' },
      h(Box, null,
        h(Text, { color: COLORS.brand, bold: true }, `${GLYPH.playhead} ${title}`),
        h(Text, { dimColor: true }, `  ${subtitle}`),
      ),
      h(Text, { dimColor: true }, rightCaption),
    ),

    // Hint bar
    h(Box, { marginTop: 1 },
      h(Text, { dimColor: true }, '↑↓ navigate · ⏎ insert · esc close'),
    ),

    // Rows.
    h(Box, { flexDirection: 'column', marginTop: 1 },
      items.length === 0
        ? h(Text, { dimColor: true }, '  (no matches)')
        : windowed.map((c, i) => {
            const absIdx = windowStart + i;
            const selected = absIdx === idx;
            return h(Box, { key: c.name },
              h(Box, { width: 3 },
                h(Text, {
                  color: selected ? COLORS.brand : undefined,
                  bold: selected,
                }, selected ? ` ${GLYPH.playhead} ` : '   '),
              ),
              h(Box, { width: 16 },
                h(Text, {
                  color: selected ? COLORS.brand : undefined,
                  wrap: 'truncate-end',
                }, c.name),
              ),
              h(Box, { flexGrow: 1 },
                h(Text, { dimColor: true, wrap: 'truncate-end' }, c.desc),
              ),
            );
          }),
    ),

    // Footer — show the scroll indicator when there's more.
    items.length > MAX_ROWS && h(Box, { marginTop: 1 },
      h(Text, { dimColor: true },
        `  ${windowStart + 1}-${Math.min(windowStart + MAX_ROWS, items.length)} of ${items.length}`,
      ),
    ),
  );
}
