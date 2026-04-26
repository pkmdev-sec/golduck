/* ─────────────────────────────────────────────────────────────────────────
 * golduck Google Gemini provider adapter
 * ─────────────────────────────────────────────────────────────────────────
 * Speaks Google's generativelanguage.googleapis.com v1beta endpoint:
 *
 *   POST /v1beta/models/<model>:streamGenerateContent?alt=sse&key=<KEY>
 *   Accept: text/event-stream
 *
 * Request shape (Anthropic → Gemini):
 *   - system_instruction.parts[].text ← system
 *   - contents: [{ role: 'user'|'model', parts: [{ text }] }]
 *       (assistant → role 'model'; user/system → 'user')
 *   - tools: [{ function_declarations: [{ name, description, parameters }]}]
 *   - generation_config: { temperature, maxOutputTokens, stopSequences }
 *
 * Response shape (Gemini SSE → Anthropic events):
 *   Each chunk is a GenerateContentResponse:
 *     { candidates: [{ content: { parts: [{ text } | { functionCall }] },
 *                       finishReason? }],
 *       usageMetadata: { promptTokenCount, candidatesTokenCount } }
 *   → emit content_block_start/delta/stop + message_delta usage.
 * ───────────────────────────────────────────────────────────────────────── */
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export function toGeminiRequest({
  system, messages, tools = null,
  max_tokens = 4096, temperature = 1.0, stop_sequences = null,
}) {
  const body = {};
  if (system) {
    const sysText = typeof system === 'string'
      ? system
      : Array.isArray(system) ? system.map((b) => b?.text || '').join('\n\n') : String(system);
    body.system_instruction = { parts: [{ text: sysText }] };
  }
  body.contents = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const content = m.content;
    const parts = [];
    if (typeof content === 'string') {
      parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input || {} }});
        } else if (block.type === 'tool_result') {
          // Gemini expects a separate content entry with role:'user' and a
          // functionResponse part. We flush any pending parts first.
          if (parts.length) body.contents.push({ role, parts: parts.splice(0) });
          const fcResult = typeof block.content === 'string'
            ? { output: block.content }
            : Array.isArray(block.content)
              ? { output: block.content.map((b) => b?.text || '').join('\n') }
              : (typeof block.content === 'object' && block.content !== null ? block.content : { output: String(block.content) });
          body.contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: block.tool_use_id || 'tool', response: fcResult }}],
          });
        }
      }
    } else {
      parts.push({ text: String(content ?? '') });
    }
    if (parts.length) body.contents.push({ role, parts });
  }
  body.generationConfig = {
    temperature,
    maxOutputTokens: max_tokens,
  };
  if (stop_sequences) body.generationConfig.stopSequences = stop_sequences;
  if (tools && tools.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      })),
    }];
  }
  return body;
}

export function translateGeminiChunk(chunk, state) {
  const out = [];
  if (!chunk || typeof chunk !== 'object') return out;
  if (!state._started) {
    state._started = true;
    out.push({ type: 'message_start', message: {
      id: `gem_${Date.now()}`,
      role: 'assistant',
      model: state.model,
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    }});
  }
  const cand = Array.isArray(chunk.candidates) ? chunk.candidates[0] : null;
  if (cand?.content?.parts) {
    for (const part of cand.content.parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (state._textIdx == null) {
          state._textIdx = state._blockCursor++;
          out.push({ type: 'content_block_start', index: state._textIdx, content_block: { type: 'text', text: '' }});
        }
        out.push({ type: 'content_block_delta', index: state._textIdx,
          delta: { type: 'text_delta', text: part.text }});
      } else if (part.functionCall) {
        if (state._textIdx != null) {
          out.push({ type: 'content_block_stop', index: state._textIdx });
          state._textIdx = null;
        }
        const idx = state._blockCursor++;
        const id = `call_${Date.now()}_${idx}`;
        out.push({ type: 'content_block_start', index: idx,
          content_block: { type: 'tool_use', id, name: part.functionCall.name || '', input: part.functionCall.args || {} }});
        // Gemini delivers args as a complete object, not a delta — emit one
        // partial_json covering the whole thing so Anthropic-side consumers
        // see the arguments on input_json_delta.
        out.push({ type: 'content_block_delta', index: idx,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args || {}) }});
        out.push({ type: 'content_block_stop', index: idx });
      }
    }
  }
  if (cand?.finishReason) {
    if (state._textIdx != null) {
      out.push({ type: 'content_block_stop', index: state._textIdx });
      state._textIdx = null;
    }
  }
  if (chunk.usageMetadata) {
    out.push({ type: 'message_delta',
      delta: { stop_reason: cand?.finishReason?.toLowerCase() === 'stop' ? 'end_turn' : (cand?.finishReason || 'end_turn') },
      usage: {
        input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
        output_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
      },
    });
    state._usageSent = true;
  }
  return out;
}

export function streamGemini({ body, baseUrl, model, apiKey, signal = null }) {
  const url = new URL(
    baseUrl.replace(/\/$/, '') +
    `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '')
  );
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const events = [];
  const listeners = [];
  let done = false;
  let error = null;
  const state = { model, _started: false, _textIdx: null, _blockCursor: 0, _usageSent: false };

  function emit(ev) {
    const l = listeners.shift();
    if (l) { l({ value: ev, done: false }); return; }
    events.push(ev);
  }
  function finish(err) {
    done = true;
    error = err || null;
    if (!err && !state._usageSent) {
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
  };

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
        try {
          const parsed = JSON.parse(data);
          for (const ev of translateGeminiChunk(parsed, state)) emit(ev);
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
