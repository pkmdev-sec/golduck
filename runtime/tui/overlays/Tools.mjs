/* ─────────────────────────────────────────────────────────────────────────
 * Tools overlay (^O) — every tool exposed to the model, with native/MCP
 * badges and a fixed-width two-column layout.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

function badgeFor(name) {
  if (String(name).includes('__')) return { label: ' mcp ',  color: 'cyan' };
  if (String(name).startsWith('rlm_')) return { label: ' rlm ',  color: 'magenta' };
  if (String(name).startsWith('memory_')) return { label: ' mem ', color: 'yellow' };
  return { label: ' core', color: 'green' };
}

function Row({ tool, selected }) {
  const b = badgeFor(tool.name);
  return h(Box, null,
    h(Box, { width: 6 },
      h(Text, { inverse: true, bold: true, color: b.color }, b.label),
    ),
    h(Box, { width: 2 },
      h(Text, { color: COLORS.brand, bold: selected }, selected ? `${GLYPH.playhead} ` : '  '),
    ),
    h(Box, { width: 28 },
      h(Text, { bold: selected, color: selected ? COLORS.brand : undefined, wrap: 'truncate-end' }, tool.name),
    ),
    h(Box, { flexGrow: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, String(tool.description || '').slice(0, 200)),
    ),
  );
}

export function Tools({ tools, onClose, hasTTY }) {
  const list = Array.isArray(tools) ? tools : [];
  const [idx, setIdx] = useState(0);
  useEffect(() => { if (idx >= list.length) setIdx(0); }, [list.length, idx]);

  useInput((_ch, key) => {
    if (key.upArrow)        setIdx((i) => Math.max(0, i - 1));
    else if (key.downArrow) setIdx((i) => Math.min(list.length - 1, i + 1));
    else if (key.escape)    onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const windowSize = 14;
  const start = Math.max(0, Math.min(idx - 4, list.length - windowSize));
  const windowed = list.slice(start, start + windowSize);

  const nativeCount = list.filter((t) => !badgeFor(t.name).label.includes('mcp')).length;
  const mcpCount = list.length - nativeCount;

  return h(OverlayFrame, {
    title: `${GLYPH.diamond} tools`,
    footer: `${list.length} total · ${nativeCount} native · ${mcpCount} mcp  ·  esc to close`,
  },
    list.length === 0
      ? h(Text, { dimColor: true }, '(no tools registered yet)')
      : h(Box, { flexDirection: 'column' },
          ...windowed.map((t, i) => h(Row, {
            key: t.name, tool: t, selected: (start + i) === idx,
          })),
          list.length > windowSize && h(Box, { marginTop: 1 },
            h(Text, { dimColor: true }, `  ${start + 1}-${start + windowed.length} of ${list.length}`),
          ),
        ),
  );
}
