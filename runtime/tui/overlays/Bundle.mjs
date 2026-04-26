/* ─────────────────────────────────────────────────────────────────────────
 * Bundle overlay — show the most recent system bundle written to
 * ~/.golduck/tmp. Re-reads every 1s.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { GLYPH } from '../theme.mjs';

const h = React.createElement;

const REFRESH_MS = 1000;
const BODY_LINES = 30;

function shortenHome(p) {
  const home = homedir();
  if (p && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function fmtMtime(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '—';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function tmpDir() {
  return join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'tmp');
}

function newestBundle() {
  const dir = tmpDir();
  if (!existsSync(dir)) return null;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return null; }
  const pick = (pred) => {
    let best = null;
    for (const name of entries) {
      if (!pred(name)) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path: full, size: st.size, mtimeMs: st.mtimeMs, mtime: st.mtime };
        }
      } catch {}
    }
    return best;
  };
  return (
    pick((n) => n.startsWith('bundle-') && n.endsWith('.md')) ||
    pick((n) => n.endsWith('.md'))
  );
}

function wrap(line, width) {
  if (!line) return [''];
  const out = [];
  let s = line;
  while (s.length > width) {
    out.push(s.slice(0, width));
    s = s.slice(width);
  }
  out.push(s);
  return out;
}

export function Bundle({ onClose, hasTTY }) {
  const [info, setInfo] = useState(null);
  const [body, setBody] = useState('');

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  useEffect(() => {
    const reload = () => {
      const pick = newestBundle();
      if (!pick) { setInfo(null); setBody(''); return; }
      setInfo(pick);
      try { setBody(readFileSync(pick.path, 'utf8')); } catch { setBody(''); }
    };
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const width = Math.max(40, Math.min(process.stdout.columns || 80, 100) - 12);
  const title = `${GLYPH.diamond} bundle`;

  if (!info) {
    return h(OverlayFrame, {
      title,
      footer: `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`,
    },
      h(Text, { dimColor: true, italic: true },
        '(no system bundle emitted yet — run a turn first)'),
    );
  }

  const sizeKB = (info.size / 1024).toFixed(1);
  const shortPath = shortenHome(info.path);
  const footer = `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s · source: ${info.path}`;
  const allLines = body.split('\n');
  const head = allLines.slice(0, BODY_LINES);
  const wrapped = head.flatMap((l) => wrap(l, width));
  const truncated = allLines.length > BODY_LINES;

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      h(Box, null,
        h(Box, { flexGrow: 1 },
          h(Text, { dimColor: true, wrap: 'truncate-middle' }, shortPath),
        ),
        h(Box, { width: 10 },
          h(Text, { dimColor: true }, `${sizeKB} KB`),
        ),
        h(Box, { width: 12 },
          h(Text, { dimColor: true }, fmtMtime(info.mtime)),
        ),
      ),
      h(Box, {
        marginTop: 1,
        flexDirection: 'column',
        borderStyle: 'single',
        borderColor: 'gray',
        paddingX: 1,
      },
        wrapped.length === 0
          ? h(Text, { dimColor: true, italic: true }, '(empty)')
          : wrapped.map((l, i) => h(Text, { key: i }, l || ' ')),
        truncated
          ? h(Text, { dimColor: true }, `… (+${allLines.length - BODY_LINES} more lines)`)
          : null,
      ),
    ),
  );
}
