/* ─────────────────────────────────────────────────────────────────────────
 * golduck post-run handoff (runtime/engine/handoff.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * At end of a run, produces a concise summary card:
 *   - tools used (grouped, with counts)
 *   - files touched by write / apply_patch
 *   - test results if any `shell` invocations looked like test runs
 *   - final verify verdict + confidence
 *   - total tokens + estimated spend
 *
 * Renders as dim ANSI below the final answer so the user gets a scannable
 * trailer. The same data is also captured as a trace event for `stats`.
 * ───────────────────────────────────────────────────────────────────────── */
import { event } from '../trace/tracer.mjs';

export function computeHandoff({ messages, usdTotal, verifyVerdict }) {
  const tools = new Map();
  const filesTouched = new Set();
  const testsLikelyRan = new Set();
  const shellCommands = [];

  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of (m.content || [])) {
      if (b.type !== 'tool_use') continue;
      tools.set(b.name, (tools.get(b.name) || 0) + 1);
      if (b.name === 'write' && b.input?.path) filesTouched.add(b.input.path);
      if (b.name === 'apply_patch' && b.input?.patch) {
        const paths = String(b.input.patch).match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g) || [];
        for (const ln of paths) filesTouched.add(ln.replace(/^\*\*\* (?:Add|Update|Delete) File: /, '').trim());
      }
      if (b.name === 'shell' && b.input?.command) {
        shellCommands.push(b.input.command);
        if (/\b(test|spec|cargo\s+(test|nextest)|pytest|jest|vitest|go\s+test|npm\s+test|pnpm\s+test)\b/.test(b.input.command)) {
          testsLikelyRan.add(b.input.command.slice(0, 120));
        }
      }
    }
  }

  const card = {
    tools_used: Object.fromEntries([...tools.entries()].sort((a, b) => b[1] - a[1])),
    files_touched: [...filesTouched],
    tests_likely_ran: [...testsLikelyRan],
    shell_commands_count: shellCommands.length,
    usd_total: Number(usdTotal.toFixed(4)),
    verify: verifyVerdict ? {
      verdict: verifyVerdict.verdict,
      confidence: verifyVerdict.confidence,
      issues: (verifyVerdict.issues || []).slice(0, 3),
    } : null,
  };
  event('handoff.card', card);
  return card;
}

export function renderHandoff(card) {
  const DIM = '\x1b[2m'; const RST = '\x1b[0m';
  const lines = [];
  lines.push(`${DIM}─── handoff ───${RST}`);
  if (Object.keys(card.tools_used).length) {
    const tt = Object.entries(card.tools_used).map(([k, v]) => `${k}×${v}`).join(' ');
    lines.push(`${DIM}tools:${RST} ${tt}`);
  }
  if (card.files_touched.length) {
    lines.push(`${DIM}files:${RST} ${card.files_touched.slice(0, 10).join(', ')}${card.files_touched.length > 10 ? ` (+${card.files_touched.length - 10})` : ''}`);
  }
  if (card.tests_likely_ran.length) {
    lines.push(`${DIM}tests:${RST} ${card.tests_likely_ran.slice(0, 3).join(' · ')}`);
  }
  if (card.verify) {
    lines.push(`${DIM}verify:${RST} ${card.verify.verdict} conf=${card.verify.confidence ?? '?'}`);
  }
  lines.push(`${DIM}spend:${RST} $${card.usd_total.toFixed(4)}`);
  return lines.join('\n');
}
