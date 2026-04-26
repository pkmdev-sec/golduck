/* ─────────────────────────────────────────────────────────────────────────
 * ReverseHistory — ctrl-R style reverse history search overlay.
 * ─────────────────────────────────────────────────────────────────────────
 * Filters the store's entries down to user turns matching a substring,
 * newest first, up to 10 matches. Arrow keys navigate, ⏎ chooses, esc
 * closes. The filter `query` is owned by the parent composer.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';
import { loadHistory } from '../history_store.mjs';

const h = React.createElement;
const MAX_MATCHES = 10;
const MAX_TEXT = 100;

function truncate(text) {
  if (text.length <= MAX_TEXT) return text;
  return text.slice(0, MAX_TEXT) + GLYPH.ellipsis;
}

export function ReverseHistory({ entries, query, onChoose, onClose, hasTTY }) {
  const all = Array.isArray(entries) ? entries : [];
  // Tag each store entry with its absolute index so we can display [i] after filtering.
  const userTurns = [];
  for (let i = 0; i < all.length; i += 1) {
    const e = all[i];
    if (e && e.kind === 'user') userTurns.push({ entry: e, index: i, source: 'session' });
  }
  // Supplement with cross-session history from disk.
  try {
    const disk = loadHistory({ limit: 200 });
    for (const d of disk) {
      userTurns.push({ entry: { kind: 'user', text: d.text }, index: -1, source: 'disk', ts: d.ts });
    }
  } catch {}
  // Newest first.
  userTurns.reverse();
  const totalUsers = userTurns.length;

  const needle = (query || '').toLowerCase();
  const filtered = (needle
    ? userTurns.filter(({ entry }) => String(entry.text || '').toLowerCase().includes(needle))
    : userTurns
  ).slice(0, MAX_MATCHES * 2);

  const [idx, setIdx] = useState(0);
  useEffect(() => { if (idx >= filtered.length) setIdx(0); }, [filtered.length, idx]);

  useInput((ch, key) => {
    if (key.upArrow)        setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(filtered.length - 1, i + 1));
    else if (key.return)    { if (filtered[idx]) onChoose?.(filtered[idx].entry.text); }
    else if (key.escape)    onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const title = `◇ history · ${filtered.length}/${totalUsers} user turns matching "${query || ''}"`;

  return h(OverlayFrame, {
    title,
    footer: '↑↓ select · ⏎ use · esc close',
  },
    filtered.length === 0
      ? h(Text, { dimColor: true }, '(no user turns matching)')
      : h(Box, { flexDirection: 'column' },
          ...filtered.map(({ entry, index, source, ts }, i) => {
            const selected = i === idx;
            const text = truncate(String(entry.text || ''));
            const marker = selected
              ? `${GLYPH.playhead} ${String(i + 1).padStart(2, '0')} `
              : '  ';
            // Session rows show the absolute entry index; disk rows show "~"
            // or the short ISO date instead of a meaningless [-1].
            const label = source === 'disk'
              ? (ts ? `[${String(ts).slice(0, 10)}] ` : '[~] ')
              : `[${index}] `;
            return h(Box, { key: `${source}-${index}-${i}` },
              h(Text, { color: selected ? COLORS.brand : undefined, bold: selected }, marker),
              h(Text, { dimColor: true }, label),
              h(Text, { bold: selected, color: selected ? COLORS.brand : undefined }, text),
            );
          }),
        ),
  );
}
