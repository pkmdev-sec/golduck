import React from 'react';
import { Box, Text } from 'ink';
// Note: ink-spinner removed — it re-renders ~10x/s and causes TUI-wide
// flicker when multiple tool cells are active.
import { COLORS, GLYPH } from '../theme.mjs';
import { Collapsible } from './Collapsible.mjs';

const h = React.createElement;

function parsePatchOps(text) {
  const ops = [];
  const re = /\*\*\* (Add|Update|Delete) File: (.+)/g;
  let m;
  while ((m = re.exec(text || ''))) ops.push({ op: m[1], path: m[2].trim() });
  return ops;
}

function prettyArgPreview(name, input) {
  if (!input) return '';
  if (name === 'apply_patch' && typeof input.patch === 'string') {
    const ops = parsePatchOps(input.patch);
    if (ops.length) {
      const files = ops.slice(0, 3).map((o) => `${o.op.toLowerCase()} ${o.path}`);
      return files.join(' · ') + (ops.length > 3 ? ` · +${ops.length - 3} more` : '');
    }
  }
  if (name === 'shell' && typeof input.command === 'string') {
    const cmd = input.command.replace(/\s+/g, ' ').slice(0, 180);
    return cmd + (input.command.length > 180 ? '…' : '');
  }
  const keys = Object.keys(input);
  if (keys.length === 1) {
    const k = keys[0];
    let v = input[k];
    if (typeof v === 'string' && v.length > 120) v = v.slice(0, 120) + '…';
    if (typeof v === 'object') v = JSON.stringify(v).slice(0, 120);
    return `${k}: ${v}`;
  }
  const s = JSON.stringify(input);
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function isLongSummary(summary) {
  if (typeof summary !== 'string' || !summary) return false;
  if (summary.length > 600) return true;
  let nl = 0;
  for (let i = 0; i < summary.length; i++) {
    if (summary.charCodeAt(i) === 10) {
      nl++;
      if (nl > 10) return true;
    }
  }
  return false;
}

/**
 * Clean single-tool row:
 *
 *   ▶ fs.read  src/auth/session.ts
 *     ✓ 4ms  export function createSession…
 *
 *   ▶ apply_patch
 *     ✓ 17ms
 *       + add  src/auth/new.ts
 *       ~ edit  src/auth/session.ts
 */
function sizeBadge(summary) {
  const bytes = summary.length;
  const lines = summary.split('\n').length;
  const size = bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;
  return lines > 1 ? `${lines}L · ${size}` : size;
}

function shimmer(tick, width = 12) {
  const ch = ['░', '▒', '▓', '█'];
  const out = [];
  for (let i = 0; i < width; i++) {
    const d = ((i + tick) % (width * 2));
    const v = d < width ? d : (width * 2 - d);
    out.push(ch[Math.min(ch.length - 1, Math.floor(v * (ch.length - 1) / width))]);
  }
  return out.join('');
}

export function ToolCell({ entry }) {
  const arg = prettyArgPreview(entry.name, entry.input);
  const color = entry.status === 'ok'    ? COLORS.success
              : entry.status === 'error' ? COLORS.error
              : COLORS.primary;
  const mark  = entry.status === 'ok'    ? GLYPH.check
              : entry.status === 'error' ? GLYPH.cross
              : null;
  const dur  = entry.duration_ms != null ? `${entry.duration_ms}ms` : '';
  const summary = entry.summary || '';
  const long = isLongSummary(summary);
  const patchOps = entry.name === 'apply_patch'
    ? parsePatchOps(summary || entry.input?.patch || '')
    : [];
  const inlineSummary = !long && summary && !patchOps.length
    ? summary.slice(0, 140)
    : '';

  return h(Box, { flexDirection: 'column', marginLeft: 1, marginTop: 1 },
    // Header row: glyph + name + dim arg preview
    h(Box, null,
      h(Text, { color: COLORS.primary }, GLYPH.playhead + ' '),
      h(Text, { color: COLORS.textPrimary, bold: true }, entry.name),
      arg && h(Text, { color: COLORS.textMuted }, `  ${arg}`),
    ),
    // Status row
    entry.status === 'running'
      ? h(Box, { marginLeft: 1 },
          h(Text, { color: COLORS.primary }, '· '),
          h(Text, { color: COLORS.textMuted }, 'running…'),
        )
      : h(Box, { flexDirection: 'column', marginLeft: 2 },
          h(Box, null,
            h(Text, { color }, mark),
            dur && h(Text, { color: COLORS.textMuted }, `  ${dur}`),
            summary && h(Text, { color: COLORS.textMuted }, `  ${sizeBadge(summary)}`),
            inlineSummary && h(Text, { color: COLORS.textMuted }, `  ${inlineSummary}`),
          ),
          // Patch ops — green add, yellow edit, red delete
          ...patchOps.slice(0, 6).map((o, i) => {
            const c = o.op === 'Add' ? COLORS.success : o.op === 'Delete' ? COLORS.error : COLORS.warning;
            const g = o.op === 'Add' ? '+' : o.op === 'Delete' ? '-' : '~';
            const lbl = o.op === 'Add' ? 'add' : o.op === 'Delete' ? 'delete' : 'edit';
            return h(Box, { key: i, marginLeft: 2 },
              h(Text, { color: c, bold: true }, `${g} `),
              h(Text, { color: COLORS.textMuted }, `${lbl}  `),
              h(Text, { color: COLORS.textPrimary }, o.path),
            );
          }),
          // Long summary → Collapsible
          long && h(Box, { marginLeft: 2, marginTop: 0 },
            h(Collapsible, {
              text: summary,
              maxLines: 10,
              expanded: entry.expanded ?? false,
            }),
          ),
        ),
  );
}
