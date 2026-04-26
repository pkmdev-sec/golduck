/* Persona overlay — verify-panel roster status. */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const DEFAULT = ['reviewer', 'adversary', 'user-advocate', 'correctness'];

function loadPersonas() {
  const home = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const envList = (process.env.GOLDUCK_PERSONA || '').split(',').filter(Boolean);
  const all = [];
  const active = envList.length ? envList : DEFAULT.slice();
  const f = join(home, 'state', 'personas.json');
  if (existsSync(f)) {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(j.active)) active.splice(0, active.length, ...j.active);
      if (Array.isArray(j.all)) all.push(...j.all);
    } catch {}
  }
  const byName = new Map(all.map((p) => [p.name, p]));
  const roster = active.map((n) => byName.get(n) || { name: n });
  for (const extra of all) {
    if (!roster.some((r) => r.name === extra.name)) roster.push(extra);
  }
  const activeSet = new Set(active);
  return { roster, activeSet };
}

function Row({ persona, active }) {
  const g = active ? GLYPH.check : GLYPH.dot;
  const color = active ? COLORS.ok : undefined;
  return h(Box, null,
    h(Box, { width: 2 }, h(Text, { color }, g)),
    h(Box, { width: 18 }, h(Text, { bold: true }, persona.name)),
    h(Box, { flexGrow: 1 },
      h(Text, { dimColor: true, wrap: 'truncate-end' },
        String(persona.description || '').slice(0, 100),
      ),
    ),
  );
}

export function Persona({ onClose, hasTTY }) {
  const [state, setState] = useState({ roster: [], activeSet: new Set() });
  useEffect(() => { setState(loadPersonas()); }, []);

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  return h(OverlayFrame, {
    title: `${GLYPH.diamond} persona`,
    footer: `${state.activeSet.size} active of ${state.roster.length}  ·  esc to close`,
  },
    state.roster.length === 0
      ? h(Text, { dimColor: true }, '(no personas configured — set GOLDUCK_PERSONA or ~/.golduck/state/personas.json)')
      : h(Box, { flexDirection: 'column' },
          ...state.roster.map((p, i) => h(Row, {
            key: i, persona: p, active: state.activeSet.has(p.name),
          })),
        ),
  );
}
