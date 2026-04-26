#!/usr/bin/env node
/* Headless TUI snapshot tool.
 *
 * Renders the droidx-parity splash, the compact header, a few sample
 * history cells, and the status line, then prints the resulting ANSI to
 * stdout. Useful for the continuous parity loop — run this against the
 * droidx binary's splash to compare visually.
 *
 *   node runtime/tui/__smoke__.mjs
 *
 * Flags (env):
 *   SMOKE_COLS=110           terminal width to simulate
 *   SMOKE_MODE=splash|chat   which scene to render
 *   GOLDUCK_AUTONOMY=high    autonomy label (high/medium/low/off)
 */
import React from 'react';
import { render, Box, Text } from 'ink';
import { Header, Splash } from './components/Header.mjs';
import { WelcomeCell } from './components/WelcomeCell.mjs';
import { StatusLine, ModeLine } from './components/StatusLine.mjs';
import { Composer } from './components/Composer.mjs';
import { UserCell } from './components/UserCell.mjs';
import { AssistantCell } from './components/AssistantCell.mjs';
import { ToolCell } from './components/ToolCell.mjs';
import { ThinkingCell } from './components/ThinkingCell.mjs';
import { VerifyCell } from './components/VerifyCell.mjs';

const h = React.createElement;

// Simulate a fixed terminal width so output looks identical across runs.
const cols = parseInt(process.env.SMOKE_COLS || '110', 10);
try { process.stdout.columns = cols; } catch {}

const mode = (process.env.SMOKE_MODE || 'splash').toLowerCase();

const banner = {
  model: 'claude-opus-4-7',
  tier: 'opus',
  thinking: { budget_tokens: 8192 },
  verify: 'auto',
  reflect: 'auto',
  budget: 10,
  toolCount: 28,
  branch: 'main',
};

const statusLine = {
  model: banner.model,
  tier: banner.tier,
  usd: 0,
  ctx_pct: 0,
  tools: banner.toolCount,
};

function Splashy() {
  return h(Box, { flexDirection: 'column' },
    h(WelcomeCell, { resumeTip: null }),
    h(ModeLine, { statusLine }),
    h(Composer, {
      value: '',
      onChange: () => {},
      onSubmit: () => {},
      hint: 'Ask anything · / for commands · @ for files',
      dim: false,
      slashHint: null,
      blink: true,
    }),
    h(StatusLine, {
      statusLine,
      interrupted: false,
      busy: false,
      tick: 0,
      sessionStart: Date.now() - 1000,
      msgCount: 0,
    }),
  );
}

function Chat() {
  return h(Box, { flexDirection: 'column' },
    h(Header, { banner }),
    h(UserCell, { text: 'Try "Set up GitHub Actions for CI/CD"' }),
    h(AssistantCell, {
      entry: {
        text: 'I will draft a GitHub Actions workflow that runs lint, typecheck, and tests on every push and PR.\n\nPlan:\n- add .github/workflows/ci.yml\n- pin node@20\n- cache pnpm store',
        usage: { input: 1200, output: 300, usd: 0.0042, ctx_pct: 12 },
      },
    }),
    h(ToolCell, {
      entry: {
        name: 'fs.read',
        input: { path: 'package.json' },
        status: 'ok',
        duration_ms: 3,
        summary: '{ "name": "proj", "version": "1.2.3" }',
      },
    }),
    h(ToolCell, {
      entry: {
        name: 'apply_patch',
        input: { patch: '*** Add File: .github/workflows/ci.yml\n*** Update File: package.json' },
        status: 'ok',
        duration_ms: 47,
        summary: '*** Add File: .github/workflows/ci.yml\n*** Update File: package.json',
      },
    }),
    h(ThinkingCell, {
      entry: { lines: 4, chars: 520, preview: 'The workflow should cache the pnpm store, pin node 20, and run checks in parallel.' },
    }),
    h(VerifyCell, {
      entry: { verdict: 'approve', confidence: 0.94, issues: [] },
    }),
    h(ModeLine, { statusLine }),
    h(Composer, {
      value: '',
      onChange: () => {},
      onSubmit: () => {},
      hint: 'Ask anything · / for commands · @ for files',
      dim: false,
      slashHint: null,
      blink: true,
    }),
    h(StatusLine, {
      statusLine,
      interrupted: false,
      busy: false,
      tick: 0,
      sessionStart: Date.now() - 8000,
      msgCount: 1,
    }),
  );
}

const inkInst = render(mode === 'chat' ? h(Chat) : h(Splashy), {
  patchConsole: false,
  exitOnCtrlC: false,
});

setTimeout(() => { inkInst.unmount(); process.exit(0); }, 120);
