#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck ask — native one-shot pipeline (runtime/core/ask.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Focused alternative to `run`:
 *
 *   1. Build system bundle (same as engine).
 *   2. Single Opus 4.7 call WITHOUT tools — just think, answer.
 *   3. Self-critique via rlm_verify(question, answer).
 *   4. If verdict=revise, re-ask once with issues surfaced.
 *   5. Print the final answer.
 *
 * Use when you want a deep thought-answer (no filesystem side effects).
 * ─────────────────────────────────────────────────────────────────── */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadRunContext } from '../context/context.mjs';
import { buildSystemBundle } from '../context/bundle.mjs';
import { route } from '../router/router.mjs';
import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { rlm_verify } from '../tools/rlm.mjs';
import { openTrace, event, closeTrace } from '../trace/tracer.mjs';

function parseArgv(argv) {
  const out = { prompt: null, quiet: false, skipVerify: false, maxRevise: 1, session: null, json: false };
  const args = [...argv];
  while (args.length) {
    const a = args.shift();
    if (a === '--quiet' || a === '-q') out.quiet = true;
    else if (a === '--skip-verify') out.skipVerify = true;
    else if (a === '--json') { out.json = true; out.quiet = true; }
    else if (a === '--max-revise') out.maxRevise = parseInt(args.shift(), 10);
    else if (a === '--session') out.session = args.shift();
    else if (a === '--') out.prompt = args.join(' ');
    else if (!out.prompt) out.prompt = a;
    else out.prompt += ' ' + a;
  }
  return out;
}

async function callOnce({ model, system, userText, max_tokens, thinking }) {
  const body = buildRequestBody({
    model, system,
    messages: [{ role: 'user', content: userText }],
    max_tokens, thinking, temperature: 1.0,
  });
  const it = streamMessages(body, { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } });
  let text = '', thinkingText = '', usage = {};
  for await (const ev of it) {
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage };
    if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') text += ev.delta.text || '';
      if (ev.delta?.type === 'thinking_delta') thinkingText += ev.delta.thinking || '';
    }
    if (ev.type === 'message_delta' && ev.usage) usage = { ...usage, ...ev.usage };
  }
  return { text: text.trim(), thinking: thinkingText, usage };
}

async function main() {
  const cli = parseArgv(process.argv.slice(2));
  if (!cli.prompt) { console.error('usage: golduck ask "<question>"'); process.exit(2); }

  const runId = randomUUID().slice(0, 12);
  const home = process.env.GOLDUCK_HOME || join(process.env.HOME, '.golduck');
  const traceFile = join(home, 'traces', `${runId}.jsonl`);
  mkdirSync(join(home, 'traces'), { recursive: true });
  openTrace({ runId, traceFile });
  process.env.GOLDUCK_RUN_ID = runId;
  process.env.GOLDUCK_TRACE_FILE = traceFile;

  const ctx = await loadRunContext({ runId, home, traceFile, cwd: process.cwd() });
  const routed = route({ prompt: cli.prompt, spec: { verify: 'on', reflect: 'off', budget: 10 }, ctx });
  const bundle = buildSystemBundle({ ctx, routed, spec: { budget: 10, mode: 'ask', prompt: cli.prompt } });
  const system = [{ type: 'text', text: bundle, cache_control: { type: 'ephemeral' } }];

  if (!cli.quiet) console.error(`\x1b[2m[ask] routed: thinking=${routed.thinking?.budget_tokens} max_tokens=${routed.max_tokens}\x1b[0m`);

  // 1. Primary answer.
  if (!cli.quiet) console.error('\x1b[2m[ask] 1/3 primary answer…\x1b[0m');
  const primary = await callOnce({
    model: routed.model, system,
    userText: cli.prompt,
    max_tokens: routed.max_tokens, thinking: routed.thinking,
  });
  let answer = primary.text;

  // 2. Verify.
  if (!cli.skipVerify) {
    if (!cli.quiet) console.error('\x1b[2m[ask] 2/3 panel-critic verify…\x1b[0m');
    const verdict = await rlm_verify({ question: cli.prompt, answer, model: 'opus' });
    event('ask.verify', verdict);
    if (verdict.verdict === 'revise' && cli.maxRevise > 0) {
      const issues = (verdict.issues || []).map((i) => '- ' + i).join('\n');
      const fix = verdict.suggested_fix || '';
      if (!cli.quiet) console.error(`\x1b[33m[ask] verdict=revise; re-asking with ${verdict.issues?.length || 0} issues\x1b[0m`);
      const retry = await callOnce({
        model: routed.model, system,
        userText:
          `Your previous answer had these issues:\n${issues}\n\n` +
          `Suggested fix direction: ${fix}\n\n` +
          `Produce an improved answer that directly addresses the issues.\n\n` +
          `# Original question\n${cli.prompt}\n\n# Previous answer\n${answer}`,
        max_tokens: routed.max_tokens, thinking: routed.thinking,
      });
      answer = retry.text;
    } else {
      if (!cli.quiet) console.error(`\x1b[32m[ask] verdict=${verdict.verdict} confidence=${verdict.confidence ?? '?'}\x1b[0m`);
    }
  }

  // 3. Print.
  if (!cli.quiet) console.error('\x1b[2m[ask] 3/3 final answer below\x1b[0m');
  if (cli.json) {
    process.stdout.write(JSON.stringify({
      run_id: runId,
      model: routed.model,
      thinking: routed.thinking,
      answer,
      question: cli.prompt,
      skip_verify: cli.skipVerify,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(answer + '\n');
  }
  closeTrace();
}

main().catch((e) => { console.error('[ask] error:', e.stack || e.message); process.exit(99); });
