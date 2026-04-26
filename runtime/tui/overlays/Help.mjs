/* ─────────────────────────────────────────────────────────────────────────
 * Help overlay — categorized hotkeys + slash commands.
 * ─────────────────────────────────────────────────────────────────────────
 * Split into semantic sections with colored headers so users can find
 * things quickly rather than scanning one long list.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS } from '../theme.mjs';
import { COMMANDS } from '../commands.mjs';

const h = React.createElement;

const HOTKEY_GROUPS = [
  { title: 'input', keys: [
    { k: '⏎',   l: 'send message (single-line) / add newline (multi)' },
    { k: '/',   l: 'open slash-command palette' },
    { k: '@',   l: 'mention a file, tool, pin, or skill' },
    { k: '⇥',   l: 'autocomplete slash command (longest common prefix)' },
    { k: '⇧⏎', l: 'insert a newline inside a message' },
  ]},
  { title: 'navigate', keys: [
    { k: 'PgUp/PgDn', l: 'scroll history by a page' },
    { k: '⇧↑/↓',      l: 'step through cells one-by-one' },
    { k: 'e',         l: 'expand / collapse the focused cell' },
    { k: '^Y',        l: 'yank (copy) the focused cell' },
    { k: 'esc',       l: 'close overlay / cancel in-flight run' },
  ]},
  { title: 'overlays', keys: [
    { k: '^H', l: 'help (this panel)' },
    { k: '^T', l: 'trace viewer' },
    { k: '^M', l: 'memory browser' },
    { k: '^K', l: 'skills picker' },
    { k: '^O', l: 'tool catalog' },
    { k: '^S', l: 'stats' },
    { k: '^Q', l: 'sessions list' },
    { k: '^R', l: 'reverse-history search' },
    { k: '^P', l: 'plan viewer' },
    { k: '^G', l: 'last apply_patch diff' },
    { k: '^B', l: 'system bundle viewer' },
    { k: '^Y', l: 'MCP server inspector' },
    { k: '^F', l: 'lessons browser' },
    { k: '^V', l: 'doctor (service health)' },
    { k: '^A', l: 'agents (RLM sub-agents)' },
    { k: '^X', l: 'metrics (latency / think ratio)' },
    { k: '^W', l: 'workspace (git status)' },
  ]},
  { title: 'control', keys: [
    { k: '^L', l: 'clear conversation history' },
    { k: '^C', l: 'interrupt; twice to exit' },
    { k: '^D', l: 'exit golduck' },
  ]},
];

function Section({ title, keys }) {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { color: COLORS.brand, bold: true }, title),
    ...keys.map((k, i) =>
      h(Box, { key: i },
        h(Box, { width: 12 },
          h(Text, { dimColor: true }, `  ${k.k}`),
        ),
        h(Text, null, k.l),
      ),
    ),
  );
}

export function Help({ onClose }) {
  const bySection = {
    query:   COMMANDS.filter((c) => ['/help','/commands','/recall','/tokens','/cost','/verify','/providers'].includes(c.name)),
    overlays:COMMANDS.filter((c) => c.opens),
    history: COMMANDS.filter((c) => ['/reset','/clear','/save','/export','/compact','/resume'].includes(c.name)),
    edit:    COMMANDS.filter((c) => ['/pin','/read','/ask','/think','/model','/undo','/busy'].includes(c.name)),
    exit:    COMMANDS.filter((c) => ['/exit','/quit'].includes(c.name)),
  };

  return h(OverlayFrame, { title: 'help · hotkeys + commands', footer: 'esc to close' },
    ...HOTKEY_GROUPS.map((g, i) => h(Section, { key: i, title: g.title, keys: g.keys })),
    h(Text, { color: COLORS.brand, bold: true }, `slash commands  (${COMMANDS.length})`),
    ...Object.entries(bySection).map(([section, cmds], i) =>
      cmds.length > 0 ? h(Box, { key: section, flexDirection: 'column', marginTop: 1 },
        h(Text, { color: COLORS.brand, dimColor: true, bold: true }, `  ${section}`),
        ...cmds.map((c, j) => h(Box, { key: j },
          h(Box, { width: 18 },
            h(Text, { dimColor: true }, `    ${c.name}`),
          ),
          h(Text, null, c.desc),
        )),
      ) : null,
    ),
  );
}
