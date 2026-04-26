/* ─────────────────────────────────────────────────────────────────────────
 * MentionPicker — typed, multi-kind @-mention picker overlay.
 * ─────────────────────────────────────────────────────────────────────────
 * Replaces the file-only FileMention overlay with a prefix-driven picker
 * that supports files, tools, pins, and skills. The composer passes its
 * raw buffer in as `input`; this overlay uses parseMention() to find the
 * active '@…' token, then scanMentions() to render a ranked list.
 *
 * On ⏎ the overlay reports back a { kind, path, insertAt, replaceLength }
 * edit to the composer so the @token can be swapped in place.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useMemo, useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { parseMention, scanMentions } from '../mention_scanner.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const VISIBLE_ROWS = 10;

function glyphFor(kind) {
  switch (kind) {
    case 'pin':   return GLYPH.square;   // ⬢ approximation from theme
    case 'skill': return GLYPH.diamond;  // ◈ approximation
    case 'tool':
    case 'file':
    default:      return GLYPH.arrow;    // ▸
  }
}

function windowStart(top, idx) {
  if (idx < top) return idx;
  if (idx > top + VISIBLE_ROWS - 1) return idx - VISIBLE_ROWS + 1;
  return top;
}

function computeReplaceLength(mention) {
  if (!mention) return 0;
  // Always include the leading '@'.
  if (mention.kind === 'file') {
    return 1 + mention.query.length;
  }
  // kind:query (plus the colon separator)
  return 1 + mention.kind.length + 1 + mention.query.length;
}

export function MentionPicker({ input, onChoose, onClose, hasTTY }) {
  const mention = useMemo(() => parseMention(input || ''), [input]);
  const items = useMemo(() => {
    if (!mention) return [];
    return scanMentions({ kind: mention.kind, query: mention.query, limit: 25 });
  }, [mention && mention.kind, mention && mention.query]);

  const [idx, setIdx] = useState(0);
  const [top, setTop] = useState(0);

  // Reset window when the item set shifts.
  useEffect(() => {
    setIdx(0);
    setTop(0);
  }, [mention && mention.kind, mention && mention.query]);

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
      const picked = items[idx];
      if (picked && mention) {
        onChoose?.({
          kind: picked.kind,
          path: picked.path,
          insertAt: mention.atIndex,
          replaceLength: computeReplaceLength(mention),
        });
      }
    } else if (key.escape) {
      onClose?.();
    }
  }, { isActive: Boolean(hasTTY) });

  const kindLabel = mention ? mention.kind : 'none';
  const n = items.length;
  const query = mention ? mention.query : '';
  const title  = `mention ${kindLabel} — ${n} match${n === 1 ? '' : 'es'} for "${query}"`;
  const footer = '↑↓ select · ⏎ insert · esc close';

  if (!mention) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true }, "(start typing '@…' to pick)"),
    );
  }

  if (n === 0) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true }, '(no matches)'),
    );
  }

  const end      = Math.min(n, top + VISIBLE_ROWS);
  const visible  = items.slice(top, end);
  const overflow = n - end;

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      ...visible.flatMap((item, i) => {
        const absIdx   = top + i;
        const selected = absIdx === idx;
        const glyph    = glyphFor(item.kind);
        const rows = [
          h(Box, { key: `row-${absIdx}` },
            h(Text, { color: selected ? COLORS.brand : undefined, bold: selected },
              `${selected ? GLYPH.playhead : ' '} `,
            ),
            h(Text, { dimColor: true }, `${glyph} `),
            h(Text, { bold: selected, color: selected ? COLORS.brand : undefined, dimColor: !selected },
              String(item.label),
            ),
          ),
        ];
        if (item.subtitle) {
          rows.push(
            h(Box, { key: `sub-${absIdx}` },
              h(Text, { dimColor: true }, `    ${item.subtitle}`),
            ),
          );
        }
        return rows;
      }),
      overflow > 0
        ? h(Text, { dimColor: true }, `  ${GLYPH.ellipsis} ${overflow} more`)
        : null,
    ),
  );
}
