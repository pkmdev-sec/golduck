/* ─────────────────────────────────────────────────────────────────────────
 * golduck Anthropic Messages adapter (extracted from engine/client.mjs).
 * ─────────────────────────────────────────────────────────────────────────
 * Pass-through: body already uses the Anthropic shape, SSE events already
 * use Anthropic names, so nothing needs translating. This file exists so
 * the dispatcher in engine/client.mjs can route by provider.adapter name.
 * ───────────────────────────────────────────────────────────────────────── */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export function streamAnthropic({ body, baseUrl, apiKey, extraHeaders = {}, signal = null }) {
  const url = new URL(baseUrl.replace(/\/$/, '') + '/messages');
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  const events = [];
  const listeners = [];
  let done = false;
  let error = null;

  function emit(ev) {
    const l = listeners.shift();
    if (l) { l({ value: ev, done: false }); return; }
    events.push(ev);
  }
  function finish(err) {
    done = true;
    error = err || null;
    while (listeners.length) {
      const l = listeners.shift();
      if (err) l(Promise.reject(err));
      else l({ value: undefined, done: true });
    }
  }

  const reqHeaders = {
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'anthropic-version': '2023-06-01',
    ...extraHeaders,
  };
  // For direct Anthropic cloud (not the local cxr proxy), pass the API key.
  if (apiKey && url.hostname !== '127.0.0.1') {
    reqHeaders['x-api-key'] = apiKey;
  }

  const req = lib.request({
    host: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname, method: 'POST',
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
        let eventName = null;
        let data = '';
        for (const line of rawEvt.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (!parsed.type && eventName) parsed.type = eventName;
          emit(parsed);
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
