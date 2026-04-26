/* ─────────────────────────────────────────────────────────────────────────
 * Skills overlay (^K)
 * ─────────────────────────────────────────────────────────────────────────
 * Lists skills discovered in `$GOLDUCK_HOME/skills/*.json` (default
 * `~/.golduck/skills/`). Each row is a compact three-column layout:
 *
 *     <name, 24w bold>  <description, flex dim truncate>  [arg] [arg]
 *
 * Selecting a row invokes `/skill <name>` via `onInvoke` and closes the
 * overlay. `useInput` inside SelectList is guarded by `hasTTY`.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { SelectList } from './SelectList.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;
const NAME_COL = 24;

function skillsDir() {
  return join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'skills');
}

function loadSkills() {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const name = f.replace(/\.json$/, '');
        try {
          const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
          return {
            name: j.name || name,
            description: j.description || '',
            required: Array.isArray(j.required_args) ? j.required_args : [],
          };
        } catch {
          return { name, description: '', required: [] };
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function SkillRow({ skill, selected }) {
  const name = String(skill.name);
  const padded = name.length >= NAME_COL ? name : name + ' '.repeat(NAME_COL - name.length);
  const nameProps = selected
    ? { bold: true, color: COLORS.brand }
    : { bold: true };
  return h(Box, { flexDirection: 'row', flexGrow: 1 },
    h(Box, { flexShrink: 0 }, h(Text, nameProps, padded)),
    h(Box, { flexGrow: 1, flexShrink: 1, marginRight: 1 },
      h(Text, { dimColor: true, wrap: 'truncate' }, skill.description || ''),
    ),
    skill.required.length > 0 && h(Box, { flexShrink: 0 },
      ...skill.required.map((arg, i) =>
        h(Text, { key: i }, i === 0 ? '' : ' ', h(Text, { inverse: true }, ` ${arg} `)),
      ),
    ),
  );
}

export function Skills({ onClose, onInvoke, hasTTY }) {
  const [skills, setSkills] = useState([]);
  useEffect(() => setSkills(loadSkills()), []);

  const title = `${GLYPH.diamond} skills${skills.length ? ' · ' + skills.length : ''}`;

  if (skills.length === 0) {
    return h(OverlayFrame, { title },
      h(Text, { dimColor: true },
        '(no skills installed — add a .json file to ~/.golduck/skills/)',
      ),
    );
  }

  return h(OverlayFrame, { title },
    h(SelectList, {
      items: skills,
      hasTTY,
      onClose,
      renderItem: (s, selected) => h(SkillRow, { skill: s, selected }),
      onSelect: (s) => { onInvoke?.(`/skill ${s.name}`); onClose?.(); },
    }),
  );
}
