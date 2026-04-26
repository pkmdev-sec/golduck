/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI — ToolChain.mjs
 * ─────────────────────────────────────────────────────────────────────────
 * Compact tree renderer for a group of tool calls fired in parallel within
 * the same assistant turn. A sibling to ToolCell (which renders a single
 * tool). The parent decides when to use this — we just render.
 *
 * Props:
 *   entries: Array<{ name, input, status, duration_ms?, summary? }>
 *   tick:    number  (animation tick for the spinner; parent increments)
 *
 * Layout:
 *    ╭─ 3 tools (parallel)
 *    ├▶ fs.read        path=runtime/store.mjs       ✓ 4ms   · store.mjs…
 *    ├▶ fs.read        path=runtime/app.mjs         ✓ 2ms   · app.mjs…
 *    └▶ apply_patch    patch=Update File: …         ✓ 17ms  · Update File: …
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const NAME_WIDTH = 12;
const ARG_WIDTH = 40;
const SUMMARY_WIDTH = 56;

function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str.slice(0, n);
  return str + ' '.repeat(n - str.length);
}

function truncate(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)) + GLYPH.ellipsis;
}

function argPreview(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'apply_patch' && typeof input.patch === 'string') {
    const m = input.patch.match(/\*\*\* (Add|Update|Delete) File: (.+)/);
    const head = m ? `${m[1].toLowerCase()} ${m[2]}` : input.patch;
    return truncate(head.replace(/\s+/g, ' '), ARG_WIDTH);
  }
  if (name === 'shell' && typeof input.command === 'string') {
    return truncate(input.command.replace(/\s+/g, ' '), ARG_WIDTH);
  }
  const keys = Object.keys(input);
  if (keys.length === 1) {
    const k = keys[0];
    let v = input[k];
    if (typeof v === 'object') v = JSON.stringify(v);
    return truncate(String(v).replace(/\s+/g, ' '), ARG_WIDTH);
  }
  return truncate(JSON.stringify(input), ARG_WIDTH);
}

function statusMark(entry) {
  if (entry.status === 'ok') {
    return h(Text, { color: COLORS.ok }, GLYPH.check);
  }
  if (entry.status === 'error') {
    return h(Text, { color: COLORS.error }, GLYPH.cross);
  }
  return h(Text, { color: COLORS.tool }, '·');
}

export function ToolChain({ entries }) {
  const list = Array.isArray(entries) ? entries : [];
  const count = list.length;
  const anyRunning = list.some((e) => e && e.status === 'running');

  const header = h(Box, null,
    h(Text, { color: COLORS.border }, ' ╭─ '),
    h(Text, { bold: true }, `${count} tool${count === 1 ? '' : 's'}`),
    h(Text, { dimColor: true }, ' (parallel)'),
    anyRunning ? h(Text, { color: COLORS.textMuted }, '  running…') : null,
  );

  const rows = list.map((entry, i) => {
    const isLast = i === list.length - 1;
    const branch = isLast ? ' └▶ ' : ' ├▶ ';
    const name = padRight(entry.name ?? '', NAME_WIDTH);
    const arg = padRight(truncate(argPreview(entry.name, entry.input), ARG_WIDTH), ARG_WIDTH);
    const dur = entry.duration_ms != null ? `${entry.duration_ms}ms` : '';
    const summary = entry.summary
      ? truncate(String(entry.summary).replace(/\s+/g, ' '), SUMMARY_WIDTH)
      : '';

    return h(Box, { key: i },
      h(Text, { color: COLORS.border }, branch),
      h(Text, { bold: true }, name),
      h(Text, null, ' '),
      h(Text, { dimColor: true }, arg),
      h(Text, null, ' '),
      statusMark(entry),
      h(Text, { dimColor: true }, ` ${padRight(dur, 6)}`),
      summary
        ? h(Text, { dimColor: true }, `· ${summary}`)
        : null,
    );
  });

  return h(Box, { flexDirection: 'column' }, header, ...rows);
}
