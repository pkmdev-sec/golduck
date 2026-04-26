/* Sessions overlay: single-row items with relative timestamp. */
import React, { useEffect, useState } from 'react';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { SelectList } from './SelectList.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

function timeAgo(tsStr) {
  if (!tsStr) return '—';
  const t = Date.parse(tsStr);
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function loadSessions() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const DIR = join(HOME, 'state', 'sessions');
  if (!existsSync(DIR)) return [];
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = join(DIR, f);
        let mtimeMs = 0;
        try { mtimeMs = statSync(full).mtimeMs; } catch {}
        return { name: f.replace(/\.json$/, ''), full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40)
      .map((entry) => {
        let updated_at = '', messages = 0, model = '';
        try {
          const j = JSON.parse(readFileSync(entry.full, 'utf8'));
          updated_at = j.updated_at || '';
          messages = Array.isArray(j.messages) ? j.messages.length : 0;
          model = j.model || '';
        } catch {}
        return { ...entry, updated_at, messages, model };
      });
  } catch { return []; }
}

export function Sessions({ onClose, onInvoke, hasTTY }) {
  const [sessions, setSessions] = useState(null);
  useEffect(() => { setSessions(loadSessions()); }, []);

  const count = sessions?.length ?? 0;
  const title = `${GLYPH.diamond} sessions`;

  if (sessions === null) {
    return h(OverlayFrame, { title, footer: 'esc to close' },
      h(Text, { dimColor: true }, '(loading…)'),
    );
  }
  if (count === 0) {
    return h(OverlayFrame, { title, footer: 'esc to close' },
      h(Text, { dimColor: true }, '(no sessions saved yet — every turn auto-saves)'),
    );
  }

  return h(OverlayFrame, { title, footer: `${count} saved  ·  ↑↓ ⏎ esc` },
    h(SelectList, {
      items: sessions, hasTTY,
      onClose,
      renderItem: (s, selected) => h(Box, null,
        h(Box, { width: 16 },
          h(Text, { bold: selected, color: selected ? COLORS.brand : undefined, wrap: 'truncate-end' }, s.name),
        ),
        h(Box, { width: 12 },
          h(Text, { dimColor: true }, timeAgo(s.updated_at)),
        ),
        h(Box, { width: 10 },
          h(Text, { dimColor: true }, `${s.messages} msg${s.messages === 1 ? '' : 's'}`),
        ),
        h(Box, { flexGrow: 1 },
          h(Text, { dimColor: true, wrap: 'truncate-end' }, s.model || '—'),
        ),
      ),
      onSelect: (s) => {
        if (onInvoke) onInvoke(`/resume ${s.name}`);
        onClose?.();
      },
    }),
  );
}
