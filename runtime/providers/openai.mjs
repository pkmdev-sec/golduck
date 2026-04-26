/* ─────────────────────────────────────────────────────────────────────────
 * golduck OpenAI-compatible provider adapter
 * ─────────────────────────────────────────────────────────────────────────
 * Speaks /chat/completions (stream=true) and converts both request and
 * response to/from the Anthropic Messages shape so the rest of the engine
 * can stay Anthropic-native.
 *
 * Used by: OpenAI, GLM, DeepSeek, xAI/Grok, Mistral, Groq, OpenRouter,
 * plus any "custom openai-compat" endpoint the user points us at.
 *
 * Translation sketch:
 *
 *   Anthropic-shaped request                OpenAI-shaped request
 *   ─────────────────────────               ───────────────────────
 *   { model, system, messages,      →       { model, messages:
 *     max_tokens, temperature,                  [{role:'system',content:system}, ...msgs],
 *     tools, stream:true, thinking }          max_tokens, temperature,
 *                                             tools: [{type:'function',function:{...}}],
 *                                             stream:true }
 *
 *   Anthropic content blocks:
 *     [{ type:'text', text }]
 *     [{ type:'tool_use', id, name, input }]
 *     [{ type:'tool_result', tool_use_id, content }]
 *   are flattened — OpenAI uses `content:string` for text and
 *   `tool_calls:[...]` on the assistant turn + `role:'tool'` followups.
 *
 *   Stream events (OpenAI `chat.completion.chunk`)
 *     choices[0].delta.content  →  {type:'content_block_delta',
 *                                   delta:{type:'text_delta', text}}
 *     choices[0].delta.tool_calls[i].function.arguments
 *                              →  {type:'content_block_delta',
 *                                   delta:{type:'input_json_delta',
 *                                          partial_json}}
 *     choices[0].finish_reason →  {type:'message_stop'}
 *     usage on last chunk      →  {type:'message_delta', usage:{...}}
 *
 * Everything else (retries, budgets, cache) stays in engine/client.mjs.
 * ───────────────────────────────────────────────────────────────────────── */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/** Convert Anthropic-shaped body → OpenAI-shaped body. */
export function toOpenAIRequest({
  model, system, messages, tools = null,
  max_tokens = 4096, temperature = 1.0, stop_sequences = null,
}) {
  const oaMessages = [];
  if (system) {
    const sysText = typeof system === 'string'
      ? system
      : Array.isArray(system) ? system.map((b) => b?.text || '').join('\n\n') : String(system);
    oaMessages.push({ role: 'system', content: sysText });
  }
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    const content = m.content;
    if (typeof content === 'string') {
      oaMessages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      oaMessages.push({ role, content: String(content ?? '') });
      continue;
    }
    // Split mixed content. Anthropic allows text+tool_use+tool_result in one
    // array; OpenAI separates them across multiple messages.
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${Date.now()}`,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((b) => b?.text || '').join('\n')
              : JSON.stringify(block.content ?? ''),
        });
      }
    }
    if (role === 'assistant') {
      const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      oaMessages.push(assistantMsg);
    } else if (role === 'user') {
      if (textParts.length) oaMessages.push({ role: 'user', content: textParts.join('\n') });
      for (const tr of toolResults) oaMessages.push(tr);
    } else {
      oaMessages.push({ role, content: textParts.join('\n') });
    }
  }

  // Reasoning-model families (o1/o3/o4) use max_completion_tokens and
  // reject non-default temperature. Detect by slug prefix.
  const isReasoning = /^(o1|o3|o4)(-|$)/.test(String(model || '').toLowerCase());
  const body = {
    model,
    messages: oaMessages,
    stream: true,
  };
  if (isReasoning) {
    body.max_completion_tokens = max_tokens;
  } else {
    body.max_tokens = max_tokens;
    body.temperature = temperature;
  }
  if (stop_sequences) body.stop = stop_sequences;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }
  return body;
}

/** Translate one OpenAI SSE chunk into 0..N Anthropic-shaped events. */
export function translateChunk(chunk, state) {
  // state tracks: whether we've emitted message_start, the current text
  // block index, open tool-call blocks per id, and the last usage.
  const out = [];
  if (!chunk || typeof chunk !== 'object') return out;
  if (!state._started) {
    state._started = true;
    out.push({ type: 'message_start', message: {
      id: chunk.id || `msg_${Date.now()}`,
      role: 'assistant',
      model: chunk.model || state.model,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    }});
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (choice) {
    const delta = choice.delta || {};
    // Plain text delta.
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (state._textIdx == null) {
        state._textIdx = state._blockCursor++;
        out.push({ type: 'content_block_start', index: state._textIdx, content_block: { type: 'text', text: '' }});
      }
      out.push({ type: 'content_block_delta', index: state._textIdx, delta: { type: 'text_delta', text: delta.content }});
    }
    // Tool-call deltas: OpenAI emits `tool_calls:[{index, id, function:{name,arguments}}]`.
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const k = tc.index ?? 0;
        const st = state._toolBlocks[k] || (state._toolBlocks[k] = {});
        // Close the text block if still open — OpenAI switches modality.
        if (state._textIdx != null) {
          out.push({ type: 'content_block_stop', index: state._textIdx });
          state._textIdx = null;
        }
        if (!st.started) {
          st.started = true;
          st.idx = state._blockCursor++;
          st.id = tc.id || `call_${Date.now()}_${k}`;
          st.name = tc.function?.name || '';
          out.push({ type: 'content_block_start', index: st.idx,
            content_block: { type: 'tool_use', id: st.id, name: st.name, input: {} }});
        }
        if (tc.function?.name && !st.name) {
          st.name = tc.function.name;
          // No standalone event for name; Anthropic infers it from the block_start above.
        }
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments.length > 0) {
          out.push({ type: 'content_block_delta', index: st.idx,
            delta: { type: 'input_json_delta', partial_json: tc.function.arguments }});
        }
      }
    }
    if (choice.finish_reason) {
      // Close any open blocks.
      if (state._textIdx != null) {
        out.push({ type: 'content_block_stop', index: state._textIdx });
        state._textIdx = null;
      }
      for (const k of Object.keys(state._toolBlocks)) {
        const st = state._toolBlocks[k];
        if (st.started && !st.closed) {
          st.closed = true;
          out.push({ type: 'content_block_stop', index: st.idx });
        }
      }
    }
  }
  if (chunk.usage) {
    out.push({ type: 'message_delta',
      delta: { stop_reason: chunk.choices?.[0]?.finish_reason || 'end_turn' },
      usage: {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      },
    });
    state._usageSent = true;
  }
  return out;
}

/** Stream /chat/completions and yield Anthropic-shaped events.
 *  Returns an object with .next() and .abort() matching the client.mjs contract. */
export function streamOpenAI({ body, baseUrl, apiKey, extraHeaders = {}, signal = null }) {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions');
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const events = [];
  const listeners = [];
  let done = false;
  let error = null;
  const state = { model: body.model, _started: false, _textIdx: null,
    _blockCursor: 0, _toolBlocks: {}, _usageSent: false };

  function emit(ev) {
    const l = listeners.shift();
    if (l) { l({ value: ev, done: false }); return; }
    events.push(ev);
  }
  function finish(err) {
    done = true;
    error = err || null;
    if (!err && !state._usageSent) {
      // Synth a terminal message_delta so the consumer sees stop_reason.
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 0, output_tokens: 0 }});
    }
    if (!err) emit({ type: 'message_stop' });
    while (listeners.length) {
      const l = listeners.shift();
      if (err) l(Promise.reject(err));
      else l({ value: undefined, done: true });
    }
  }

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    ...extraHeaders,
  };
  if (apiKey) reqHeaders['authorization'] = `Bearer ${apiKey}`;

  const req = lib.request({
    host: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + (url.search || ''), method: 'POST',
    headers: reqHeaders, protocol: url.protocol,
  }, (res) => {
    if (res.statusCode !== 200) {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => finish(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 1000)}`)));
      return;
    }
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvt = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let data = '';
        for (const line of rawEvt.split('\n')) {
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        if (data === '[DONE]') continue; // OpenAI-style terminator
        try {
          const parsed = JSON.parse(data);
          for (const ev of translateChunk(parsed, state)) emit(ev);
        } catch {
          emit({ type: 'parse_error', raw: data.slice(0, 200) });
        }
      }
    });
    res.on('end', () => finish(null));
    res.on('error', (e) => finish(e));
  });
  req.on('error', (e) => finish(e));
  if (signal) {
    signal.addEventListener('abort', () => {
      try { req.destroy(); } catch {}
      finish(new Error('aborted'));
    });
  }
  req.setNoDelay(true);
  req.write(JSON.stringify(body));
  req.end();

  return {
    async next() {
      if (events.length) return { value: events.shift(), done: false };
      if (done) {
        if (error) throw error;
        return { value: undefined, done: true };
      }
      return new Promise((resolve, reject) => {
        listeners.push((r) => {
          if (r instanceof Promise) r.catch(reject);
          else resolve(r);
        });
      });
    },
    [Symbol.asyncIterator]() { return this; },
    abort() { try { req.destroy(); } catch {} },
  };
}
