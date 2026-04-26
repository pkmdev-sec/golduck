/* ─────────────────────────────────────────────────────────────────────────
 * FileMention — @-mention file picker overlay.
 * ─────────────────────────────────────────────────────────────────────────
 * Opens when the composer detects an unresolved `@query` token. Filters the
 * repo via file_scanner and lets the user arrow-select a path to inject
 * back into the composer.
 *
 * Rendering:
 *   - Up to VISIBLE_ROWS items are rendered at once; the window scrolls to
 *     keep the selected index on screen.
 *   - A dim "… N more" line is shown below the window when the full result
 *     set is longer than the viewport.
 *
 * Perf: `scanFilesSync` is called on every `query` change. The scanner
 * itself memoizes the directory walk with a short TTL, so only rank/sort
 * runs per keystroke.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect } from 'react';
import path from 'node:path';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { scanFilesSync } from '../file_scanner.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const DIR_TAIL_MAX = 40;
const VISIBLE_ROWS = 10;

function tailDir(p) {
  const dir = path.dirname(p);
  if (!dir || dir === '.' || dir === '/') return '';
  if (dir.length <= DIR_TAIL_MAX) return dir;
  return `${GLYPH.ellipsis}${dir.slice(dir.length - DIR_TAIL_MAX + 1)}`;
}

/* Compute the top-of-window so that `idx` is always visible. */
function windowStart(top, idx) {
  if (idx < top) return idx;
  if (idx > top + VISIBLE_ROWS - 1) return idx - VISIBLE_ROWS + 1;
  return top;
}

export function FileMention({ query, onChoose, onClose, hasTTY }) {
  const [items, setItems] = useState(() =>
    scanFilesSync({ cwd: process.cwd(), query: query || '', limit: 30 }),
  );
  const [idx, setIdx] = useState(0);
  const [top, setTop] = useState(0);

  // Rescan whenever the mention query changes.
  useEffect(() => {
    const next = scanFilesSync({ cwd: process.cwd(), query: query || '', limit: 30 });
    setItems(next);
    setIdx(0);
    setTop(0);
  }, [query]);

  useInput((ch, key) => {
    if (key.upArrow) {
      setIdx((i) => {
        const n = Math.max(0, i - 1);
        setTop((t) => windowStart(t, n));
        return n;
      });
    } else if (key.downArrow) {
      setIdx((i) => {
        const n = Math.min(items.length - 1, i + 1);
        setTop((t) => windowStart(t, n));
        return n;
      });
    } else if (key.return) {
      if (items[idx]) onChoose?.({ path: items[idx].path });
    } else if (key.escape) {
      onClose?.();
    }
  }, { isActive: Boolean(hasTTY) });

  const qLabel = query || '';
  const title  = `mention files — ${items.length} matches for "${qLabel}"`;
  const footer = '↑↓ select · ⏎ insert · esc close';

  if (!query) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true }, 'type to filter'),
    );
  }

  if (items.length === 0) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true }, '(no matches)'),
    );
  }

  const end     = Math.min(items.length, top + VISIBLE_ROWS);
  const visible = items.slice(top, end);
  const overflow = items.length - end;

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      ...visible.map((item, i) => {
        const absIdx  = top + i;
        const selected = absIdx === idx;
        const glyph    = item.kind === 'dir' ? GLYPH.arrow : GLYPH.dot;
        const base     = path.basename(item.path);
        const parent   = tailDir(item.path);
        return h(Box, { key: item.path },
          h(Text, { color: selected ? COLORS.brand : undefined, bold: selected },
            `${selected ? GLYPH.playhead : ' '} `,
          ),
          h(Text, { dimColor: true }, `${glyph} `),
          h(Text, { bold: selected, color: selected ? COLORS.brand : undefined }, base),
          parent
            ? h(Text, { dimColor: true }, `  ${parent}`)
            : null,
        );
      }),
      overflow > 0
        ? h(Text, { dimColor: true }, `  ${GLYPH.ellipsis} ${overflow} more`)
        : null,
    ),
  );
}
