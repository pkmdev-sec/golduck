/* Trace overlay (^T): tail the current run's JSONL trace. */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const COLOR_FOR = {
  'run.start':       'magenta',
  'route.decision':  'blue',
  'gate.blocked':    'red',
  'engine.request':  'cyan',
  'engine.response': 'cyan',
  'engine.thinking': 'gray',
  'verify.verdict':  'green',
  'verify.issue':    'yellow',
  'handoff.card':    'magenta',
  'retry.attempt':   'yellow',
  'tool.call':       'cyan',
  'span.exit':       'gray',
};

const TIME_W = 8;
const NAME_W = 22;
const META_KEYS = new Set(['ts', 'run_id', 'kind', 'name']);

function formatTime(ts) {
  const s = typeof ts === 'string' ? ts.slice(11, 19) : '';
  return s.padEnd(TIME_W).slice(0, TIME_W);
}

function formatPayload(ev, width) {
  const parts = [];
  for (const [k, v] of Object.entries(ev)) {
    if (META_KEYS.has(k)) continue;
    const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${raw.slice(0, 40)}`);
    if (parts.length >= 3) break;
  }
  const joined = parts.join(' ');
  if (width > 1 && joined.length > width) return joined.slice(0, width - 1) + '…';
  return joined;
}

export function Trace({ onClose, hasTTY }) {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const traceFile = join(
      process.env.GOLDUCK_HOME || join(homedir(), '.golduck'),
      'traces',
      'current.jsonl',
    );
    const reload = () => {
      if (!existsSync(traceFile)) return;
      try {
        const lines = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
        const parsed = [];
        for (const l of lines.slice(-40)) {
          try { parsed.push(JSON.parse(l)); } catch { /* skip */ }
        }
        setEvents(parsed);
      } catch { /* ignore transient read errors */ }
    };
    reload();
    const id = setInterval(reload, 500);
    return () => clearInterval(id);
  }, []);

  if (hasTTY) {
    useInput((_input, key) => {
      if (key.escape && typeof onClose === 'function') onClose();
    });
  }

  const cols = process.stdout.columns || 80;
  const frameWidth = Math.min(cols, 100);
  // OverlayFrame uses paddingX: 2 + round border (2 cols) → inner ≈ width - 6.
  const payloadWidth = Math.max(10, frameWidth - 6 - TIME_W - 2 - NAME_W - 2);

  const header = h(Box, null,
    h(Text, { bold: true, dimColor: true }, 'time'.padEnd(TIME_W)),
    h(Text, null, '  '),
    h(Text, { bold: true, dimColor: true }, 'event'.padEnd(NAME_W)),
    h(Text, null, '  '),
    h(Text, { bold: true, dimColor: true }, 'payload'),
  );

  const body = events.length === 0
    ? h(Text, { dimColor: true }, '(no events yet — send a prompt to begin tracing)')
    : events.map((ev, i) =>
        h(Box, { key: i },
          h(Text, { dimColor: true }, formatTime(ev.ts)),
          h(Text, null, '  '),
          h(Text, { color: COLOR_FOR[ev.name] || COLORS.brand },
            (ev.name || '—').padEnd(NAME_W).slice(0, NAME_W),
          ),
          h(Text, null, '  '),
          h(Text, { dimColor: true }, formatPayload(ev, payloadWidth)),
        ),
      );

  return h(OverlayFrame, { title: `${GLYPH.diamond} trace` },
    h(Box, { flexDirection: 'column' }, header, body),
  );
}
