/* ─────────────────────────────────────────────────────────────────────────
 * golduck context compactor (runtime/engine/compact.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Monitors conversation size. When the estimated token count exceeds the
 * soft threshold, summarize the oldest N turns via a single Opus 4.7
 * call, then splice the summary in place of those turns.
 *
 * The summary preserves:
 *   - user intent + key decisions
 *   - each tool_use + its outcome (approve/revise)
 *   - any files touched (paths)
 *   - open questions / TODOs
 *
 * Opus 4.7 can handle 1M tokens on Bedrock, so we only compact near the
 * 900k mark by default. That gives massive runway.
 * ───────────────────────────────────────────────────────────────────────── */
import { streamMessages, buildRequestBody } from './client.mjs';
import { event } from '../trace/tracer.mjs';

const CHARS_PER_TOK = 3.5;
const SOFT = parseInt(process.env.GOLDUCK_COMPACT_SOFT || '700000', 10); // 700k tokens
const HARD = parseInt(process.env.GOLDUCK_COMPACT_HARD || '900000', 10); // 900k tokens
const KEEP_TAIL = parseInt(process.env.GOLDUCK_COMPACT_KEEP || '12', 10);

export function estimateTokens(messages, system) {
  let chars = 0;
  if (typeof system === 'string') chars += system.length;
  else if (Array.isArray(system)) for (const b of system) chars += (b.text || '').length;
  for (const m of messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const blk of m.content) {
        if (blk.text) chars += blk.text.length;
        if (blk.thinking) chars += blk.thinking.length;
        if (blk.input) chars += JSON.stringify(blk.input).length;
        if (blk.content) chars += String(blk.content).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOK);
}

async function summarizeWindow({ model, window }) {
  const system = [{
    type: 'text',
    text: [
      'You are a conversation compactor.',
      'You will receive a slice of an agent transcript (user turns, assistant responses with tool_use blocks, and tool_results).',
      'Produce a dense summary with these sections:',
      '- User intents: one bullet per concrete ask/decision',
      '- Tools used: grouped by tool name, with a 1-line outcome each',
      '- Files touched: absolute/relative paths only',
      '- Open questions / pending actions',
      '- Key facts to preserve (decisions, constraints, test results)',
      'Be concrete and terse. No preamble.',
    ].join('\n'),
  }];
  const user = {
    role: 'user',
    content: `# Transcript slice to compact\n\n${JSON.stringify(window, null, 2).slice(0, 400_000)}\n\nProduce the compact summary.`,
  };
  const compactThinkBudget = parseInt(process.env.GOLDUCK_COMPACT_THINK || '8000', 10);
  const body = buildRequestBody({
    model, system,
    messages: [user],
    max_tokens: 12000,
    temperature: 1.0,
    thinking: compactThinkBudget > 0 ? { type: 'enabled', budget_tokens: compactThinkBudget } : null,
  });
  const it = streamMessages(body);
  let text = '';
  for await (const ev of it) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
  }
  return text.trim();
}

/** Extract the prior summary + generation count from a compaction marker. */
function _extractPriorSummary(messages) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const content = typeof m.content === 'string' ? m.content : null;
    if (!content || !content.startsWith('<golduck-compaction')) continue;
    // Pull the generation count if present; first-round messages omit it.
    const genMatch = content.match(/<golduck-compaction(?:\s+gen="(\d+)")?>/);
    const gen = genMatch && genMatch[1] ? parseInt(genMatch[1], 10) : 1;
    const bodyMatch = content.match(/<golduck-compaction[^>]*>\n?([\s\S]*?)\n?<\/golduck-compaction>/);
    const body = bodyMatch ? bodyMatch[1] : content;
    return { gen, body };
  }
  return null;
}

/** Returns possibly compacted messages + a boolean flag. Mutates nothing.
 *
 *  Rolling-window semantics: when a compaction marker already exists in the
 *  transcript, the next compaction:
 *    1. Carries forward the prior summary body as context into the new summarize
 *       call (so decisions made long ago don't vanish).
 *    2. Bumps the generation counter so /trace can see how many rounds ran.
 *    3. Only summarizes the new head (messages before the tail window), not
 *       the entire transcript each time.
 *  On the first compaction, behavior matches the legacy one-shot flow. */
export async function maybeCompact({ messages, system, model }) {
  const est = estimateTokens(messages, system);
  if (est < SOFT) return { messages, compacted: false, est };
  if (messages.length <= KEEP_TAIL + 2) return { messages, compacted: false, est };

  const prior = _extractPriorSummary(messages);
  const head = messages.slice(0, messages.length - KEEP_TAIL);
  const tail = messages.slice(messages.length - KEEP_TAIL);

  event('compact.start', { est_tokens: est, head_len: head.length, tail_len: tail.length, generation: prior ? prior.gen : 0 });

  // Build the summarization window: if a prior summary exists, prepend it as
  // a synthetic context message so the summarizer knows the accumulated state.
  const windowForSummarize = prior
    ? [{ role: 'user', content: `# Prior compaction summary (generation ${prior.gen})\n${prior.body}\n\n---` }, ...head]
    : head;

  const summary = await summarizeWindow({ model, window: windowForSummarize });
  const gen = prior ? prior.gen + 1 : 1;
  event('compact.done', { summary_chars: summary.length, generation: gen });

  const newMessages = [
    {
      role: 'user',
      content: `<golduck-compaction gen="${gen}">\nEarlier conversation was compacted (generation ${gen}). Summary below.\n\n${summary}\n</golduck-compaction>`,
    },
    ...tail,
  ];
  return { messages: newMessages, compacted: true, est, summary, generation: gen };
}

export { _extractPriorSummary };
