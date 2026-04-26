/* ─────────────────────────────────────────────────────────────────────────
 * Workspace overlay — git status + branch + recent commits at a glance.
 * ─────────────────────────────────────────────────────────────────────────
 * This is the "what is my working tree like right now" overlay.  Polls
 * every 3s while open.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { execSync } from 'node:child_process';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

function run(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim(); }
  catch { return ''; }
}

function loadWorkspace() {
  const branch = run('git rev-parse --abbrev-ref HEAD');
  if (!branch) return { notGit: true };
  const status = run('git status --porcelain');
  const ahead = run('git rev-list --count @{u}..HEAD 2>/dev/null');
  const behind = run('git rev-list --count HEAD..@{u} 2>/dev/null');
  const staged = [];
  const modified = [];
  const untracked = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    const path = line.slice(3);
    if (x === '?' && y === '?') untracked.push(path);
    else if (x !== ' ' && x !== '?') staged.push({ op: x, path });
    if (y !== ' ' && y !== '?') modified.push({ op: y, path });
  }
  const log = run("git log --oneline -n 5 --no-decorate");
  const recent = log.split('\n').filter(Boolean).map((l) => {
    const sp = l.indexOf(' ');
    return { sha: l.slice(0, sp), msg: l.slice(sp + 1).slice(0, 80) };
  });
  return { branch, ahead, behind, staged, modified, untracked, recent };
}

function Row({ op, path, color }) {
  return h(Box, null,
    h(Text, { color, bold: true }, op.padEnd(2)),
    h(Text, { dimColor: true }, '  '),
    h(Text, null, path),
  );
}

export function Workspace({ onClose, hasTTY }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const reload = () => { try { setState(loadWorkspace()); } catch { setState({ notGit: true }); } };
    reload();
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, []);

  if (!state) return h(OverlayFrame, { title: `${GLYPH.diamond} workspace · loading` }, h(Text, { dimColor: true }, 'loading…'));
  if (state.notGit) {
    return h(OverlayFrame, { title: `${GLYPH.diamond} workspace · not a git repo` },
      h(Text, { dimColor: true }, `cwd: ${process.cwd()}`),
    );
  }

  const totalChanges = state.staged.length + state.modified.length + state.untracked.length;

  return h(OverlayFrame, {
    title: `◇ workspace · ${state.branch}${state.ahead ? ` · ahead ${state.ahead}` : ''}${state.behind ? ` · behind ${state.behind}` : ''}  ·  ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
    footer: 'esc to close · refresh=3s',
  },
    state.staged.length > 0 && h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: COLORS.ok, bold: true }, 'Staged'),
      ...state.staged.slice(0, 10).map((f, i) => h(Row, { key: i, op: f.op, path: f.path, color: COLORS.ok })),
    ),
    state.modified.length > 0 && h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { color: COLORS.warn, bold: true }, 'Modified'),
      ...state.modified.slice(0, 10).map((f, i) => h(Row, { key: i, op: f.op, path: f.path, color: COLORS.warn })),
    ),
    state.untracked.length > 0 && h(Box, { flexDirection: 'column', marginBottom: 1 },
      h(Text, { dimColor: true, bold: true }, 'Untracked'),
      ...state.untracked.slice(0, 10).map((p, i) => h(Row, { key: i, op: '?', path: p, color: undefined })),
    ),
    totalChanges === 0 && h(Text, { color: COLORS.ok }, `${GLYPH.check} clean working tree`),
    h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { color: COLORS.brand, bold: true }, 'Recent commits'),
      ...state.recent.map((c, i) =>
        h(Box, { key: i },
          h(Text, { dimColor: true }, c.sha.padEnd(9)),
          h(Text, null, c.msg),
        ),
      ),
    ),
  );
}
