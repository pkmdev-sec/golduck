/* ─────────────────────────────────────────────────────────────────────────
 * Reflect overlay — browse lessons extracted from recent runs
 * (~/.golduck/memory/lessons.jsonl). Periodically reloads.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const REFRESH_MS = 2000;
const MAX_ROWS = 15;

function lessonsPath() {
  return join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'memory', 'lessons.jsonl');
}

function loadLessons() {
  const f = lessonsPath();
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtClock(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts).slice(11, 16) || '--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fmtStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export function Reflect({ onClose, hasTTY }) {
  const [lessons, setLessons] = useState(() => loadLessons());

  useEffect(() => {
    const reload = () => { try { setLessons(loadLessons()); } catch { /* swallow */ } };
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const title = `${GLYPH.diamond} reflect`;
  const footer = `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`;

  if (lessons.length === 0) {
    return h(OverlayFrame, { title, footer },
      h(Text, { dimColor: true, italic: true },
        '(no lessons yet — completed turns with verify.revise feedback populate this)'),
    );
  }

  const sorted = [...lessons].sort((a, b) => {
    const ta = new Date(a.ts || 0).getTime() || 0;
    const tb = new Date(b.ts || 0).getTime() || 0;
    return ta - tb;
  });
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const items = sorted.slice(-MAX_ROWS).reverse();

  const header = `· ${lessons.length} lessons · ${fmtStamp(oldest?.ts)} → ${fmtStamp(newest?.ts)}`;

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, header),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        ...items.map((it, i) => {
          const q = truncate(String(it.question || '(no question)'), 80);
          const tail = it.suggested_fix
            ? `fix: ${truncate(String(it.suggested_fix), 120)}`
            : `issues: ${truncate((Array.isArray(it.issues) ? it.issues : []).join('; '), 120)}`;
          return h(Box, { key: `l${i}`, flexDirection: 'column' },
            h(Box, null,
              h(Box, { width: 5 }, h(Text, { dimColor: true }, fmtClock(it.ts))),
              h(Box, { flexGrow: 1 },
                h(Text, { bold: true, wrap: 'truncate-end' }, q),
              ),
            ),
            h(Box, null,
              h(Box, { width: 5 }),
              h(Box, { flexGrow: 1 },
                h(Text, { dimColor: true, wrap: 'truncate-end' }, tail),
              ),
            ),
          );
        }),
      ),
    ),
  );
}
