/* Memory overlay (^M): list of pinned facts + recent lessons from disk. */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { SelectList } from './SelectList.mjs';
import { GLYPH } from '../theme.mjs';

const h = React.createElement;

function loadPins() {
  const f = join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'memory', 'pins.json');
  try { return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []; } catch { return []; }
}
function loadLessons() {
  const f = join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'memory', 'lessons.jsonl');
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-30).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function timeAgo(tsStr) {
  if (!tsStr) return '—';
  const t = typeof tsStr === 'number' ? tsStr : Date.parse(tsStr);
  if (!Number.isFinite(t)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function padEnd(s, n) {
  s = String(s ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

export function Memory({ onClose, hasTTY }) {
  const [pins, setPins] = useState([]);
  const [lessons, setLessons] = useState([]);
  useEffect(() => { setPins(loadPins()); setLessons(loadLessons()); }, []);
  const items = [
    ...pins.map((p) => ({ kind: 'pin', label: p.key, ts: p.ts })),
    ...lessons.map((l) => ({ kind: 'lesson', label: l.question || '', ts: l.ts })),
  ];
  return h(OverlayFrame, { title: `${GLYPH.diamond} memory` },
    h(SelectList, {
      items, hasTTY, onClose,
      renderItem: (it, selected) => {
        const badgeText = padEnd(`[${it.kind}]`, 8);
        const badgeColor = it.kind === 'pin' ? 'magenta' : 'yellow';
        const ago = timeAgo(it.ts);
        const label = truncate(it.label || '(untitled)', 48);
        return h(Box, { flexGrow: 1 },
          h(Text, { color: badgeColor, inverse: true }, badgeText),
          h(Text, null, ' '),
          h(Box, { flexGrow: 1 },
            h(Text, { bold: selected }, label),
          ),
          h(Text, { dimColor: true }, padEnd(ago, 8)),
        );
      },
      onSelect: () => { /* inspect no-op */ },
    }),
  );
}
