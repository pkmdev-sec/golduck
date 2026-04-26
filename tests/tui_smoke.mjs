/* End-to-end visual smoke for the golduck ink TUI.
 * Renders <App/> headlessly, pushes every event kind through the store,
 * then unmounts. Use:  script -q /dev/null node tests/tui_smoke.mjs < /dev/null
 */
import React from 'react';
import { render } from 'ink';
import { App } from '../runtime/tui/App.mjs';
import { getStore } from '../runtime/tui/store.mjs';

const h = React.createElement;
const store = getStore();
store.push('banner', {
  model: 'claude-opus-4-7', tier: 'opus',
  thinking: { budget_tokens: 16000 },
  verify: 'auto', reflect: 'auto', budget: 10,
  toolCount: 28, branch: 'main',
});
store.push('tool_catalog', { tools: [
  { name: 'fs.read',      description: 'Read a file' },
  { name: 'apply_patch',  description: 'Apply a V4A-style multi-file patch' },
  { name: 'shell',        description: 'Run a shell command' },
  { name: 'rlm_query',    description: 'Focused sub-query over a text slice' },
  { name: 'mcp__obscura__browser_open', description: 'Open a URL in the headless browser' },
] });

store.push('user', { text: 'Rewire the engine_tui adapter and verify my changes.' });
store.push('recall', { hits: [
  { kind: 'lesson', text: 'Prefer store.push over renderer.line() in ink runs', score: 0.82 },
  { kind: 'journal', text: 'Last time we forgot to push tool_catalog → Tools overlay was empty', score: 0.71 },
], query: 'rewire engine adapter' });
store.push('plan', { goal: 'wire the tui', steps: [
  { id: '1', title: 'extend store events', status: 'ok' },
  { id: '2', title: 'dispatch slash commands', status: 'running' },
  { id: '3', title: 'hook engine_tui to new events', status: 'pending' },
  { id: '4', title: 'write tests',                  status: 'pending' },
] });
store.push('thinking_summary', { lines: 6, chars: 412, preview: 'plan: extend the store with new event kinds, then adapt the engine…' });
store.push('busy', { busy: true, label: 'tools(2)' });
store.push('tool_use', { id: 't1', name: 'read',         input: { path: 'runtime/tui/store.mjs' } });
store.push('tool_use', { id: 't2', name: 'apply_patch',  input: { patch: '*** Begin Patch\n*** Update File: runtime/tui/store.mjs\n@@\n-case ...\n+case ...\n*** End Patch' } });
await new Promise((r) => setTimeout(r, 200));
store.push('tool_done', { id: 't1', ok: true, summary: '// store.mjs...', duration_ms: 4 });
store.push('tool_done', { id: 't2', ok: true, summary: '*** Update File: runtime/tui/store.mjs', duration_ms: 17 });
store.push('busy', { busy: false });

store.push('assistant_start', {});
const msg = '## Done\n\nStore now holds `busy`, `recall`, `tool_catalog`, and `plan` events. See `runtime/tui/store.mjs:42`.\n\n- added CompactCell rendering\n- wired engine_tui.mjs to emit `tool_catalog` + `recall`\n- persisted last apply_patch for `/diff`\n';
for (const ch of msg) {
  store.push('assistant_text', { delta: ch });
  if (Math.random() < 0.05) await new Promise((r) => setTimeout(r, 3));
}
store.push('usage', { input: 2418, output: 512, cache_read: 11_207, cache_write: 31_288, usd: 0.0473, ctx_pct: 2.3 });
store.push('verify', { verdict: 'approve', confidence: 0.92, issues: [] });
store.push('handoff', {
  tools_used: { read: 1, apply_patch: 1 },
  files_touched: ['runtime/tui/store.mjs', 'runtime/tui/engine_tui.mjs'],
  tests_likely_ran: ['node tests/run_tests.mjs → 39 passed'],
  verify: { verdict: 'approve', confidence: 0.92 },
  usd_total: 0.0473,
});
store.push('compact', { est_tokens: 700_123 });
store.push('error', { message: 'demo: a surfaced error row for style verification' });

const inst = render(h(App, { onSubmit: (t) => { store.push('user', { text: t }); } }));
await new Promise((r) => setTimeout(r, 1500));
process.exit(0);
