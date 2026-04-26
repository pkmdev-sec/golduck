/* Diff overlay — renders the most recent apply_patch as a coloured diff. */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;
const MAX_ROWS = 300;

function patchFile() {
  const home = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  return join(home, 'state', 'last_patch.txt');
}

function parseRow(line) {
  if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) return null;
  let m;
  if ((m = line.match(/^\*\*\* Add File: (.+)/))) return { kind: 'add',    path: m[1].trim() };
  if ((m = line.match(/^\*\*\* Update File: (.+)/))) return { kind: 'edit', path: m[1].trim() };
  if ((m = line.match(/^\*\*\* Delete File: (.+)/))) return { kind: 'del',  path: m[1].trim() };
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (line.startsWith('+++')) return null;
  if (line.startsWith('---')) return null;
  if (line.startsWith('+')) return { kind: 'plus',  text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'minus', text: line.slice(1) };
  return { kind: 'ctx', text: line };
}

function summarize(rows) {
  const ops = rows.filter((r) => r && ['add','edit','del'].includes(r.kind));
  return {
    adds: ops.filter((o) => o.kind === 'add').length,
    edits: ops.filter((o) => o.kind === 'edit').length,
    dels: ops.filter((o) => o.kind === 'del').length,
  };
}

function Row({ row, i }) {
  if (!row) return null;
  if (row.kind === 'add')  return h(Text, { color: COLORS.ok,    bold: true }, `+ add    ${row.path}`);
  if (row.kind === 'edit') return h(Text, { color: COLORS.warn,  bold: true }, `~ edit   ${row.path}`);
  if (row.kind === 'del')  return h(Text, { color: COLORS.error, bold: true }, `- delete ${row.path}`);
  if (row.kind === 'hunk') return h(Text, { dimColor: true, italic: true }, row.text);
  if (row.kind === 'plus') return h(Text, { color: COLORS.ok },     `+ ${row.text}`);
  if (row.kind === 'minus')return h(Text, { color: COLORS.error }, `- ${row.text}`);
  return h(Text, { dimColor: true }, `  ${row.text}`);
}

export function Diff({ onClose, hasTTY }) {
  const [rows, setRows] = useState([]);
  const [path, setPath] = useState(null);
  useEffect(() => {
    const f = patchFile();
    if (!existsSync(f)) return;
    try {
      const src = readFileSync(f, 'utf8');
      const parsed = src.split('\n').map(parseRow).filter(Boolean);
      setRows(parsed.slice(0, MAX_ROWS));
      setPath(f);
    } catch {}
  }, []);

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const sum = summarize(rows);
  const badge = `${sum.adds > 0 ? `+${sum.adds} ` : ''}${sum.edits > 0 ? `~${sum.edits} ` : ''}${sum.dels > 0 ? `-${sum.dels} ` : ''}`.trim();

  return h(OverlayFrame, {
    title: `${GLYPH.diamond} diff`,
    footer: `${badge || 'no changes'}  ·  ${path ? path.replace(homedir(), '~') : '(no last_patch)'}  ·  esc to close`,
  },
    rows.length === 0
      ? h(Text, { dimColor: true }, '(no apply_patch captured yet — run a patch first)')
      : h(Box, { flexDirection: 'column' },
          ...rows.slice(0, MAX_ROWS).map((r, i) => h(Box, { key: i }, h(Row, { row: r, i }))),
          rows.length >= MAX_ROWS && h(Text, { dimColor: true }, `… truncated at ${MAX_ROWS} rows`),
        ),
  );
}
