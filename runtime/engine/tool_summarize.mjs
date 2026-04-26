/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool-result summarizer (runtime/engine/tool_summarize.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Tools like `ls` in a huge repo or `grep` over node_modules can return
 * megabytes. Feeding that back to Opus blows context + drowns the model.
 *
 * Strategy: if a tool result string exceeds MAX_RAW_CHARS, we sub-agent
 * summarize it against the last user intent — keeping only what's
 * relevant. Otherwise pass through as-is.
 *
 * Cheap: one Opus call per over-sized result. No thinking.
 * ───────────────────────────────────────────────────────────────────────── */
import { streamMessages, buildRequestBody } from './client.mjs';
import { event } from '../trace/tracer.mjs';
import { resolveModel } from './model_policy.mjs';

const MAX_RAW_CHARS = 40_000;

export async function summarizeIfHuge({ toolName, content, userIntent }) {
  if (!content || content.length <= MAX_RAW_CHARS) return content;
  event('tool.summarize_start', { tool: toolName, bytes: content.length });

  const system = [{
    type: 'text',
    text:
      'You are a tool-output summarizer. You will receive the raw output of a tool call and the original user intent. ' +
      'Your job: return a concise, structured summary that preserves every fact the agent needs to proceed. ' +
      'Drop boilerplate. Keep paths, names, identifiers, numbers, and any counterexamples. No preamble.',
  }];
  const user = {
    role: 'user',
    content:
      `# User intent (so you know what matters)\n${(userIntent || '(unknown)').slice(0, 2000)}\n\n` +
      `# Raw output of tool \`${toolName}\` (${content.length} chars)\n` +
      '```\n' +
      content.slice(0, 300_000) +
      (content.length > 300_000 ? `\n... [${content.length - 300_000} more bytes elided]` : '') +
      '\n```\n\nProduce the summary.',
  };
  const body = buildRequestBody({
    model: resolveModel(), system,
    messages: [user],
    max_tokens: 8000,
    temperature: 1.0,
  });
  const it = streamMessages(body);
  let text = '';
  for await (const ev of it) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
  }
  event('tool.summarize_done', { tool: toolName, orig: content.length, out: text.length });
  return `[golduck auto-summarized ${toolName} output (orig=${content.length} chars)]\n\n${text.trim()}`;
}
