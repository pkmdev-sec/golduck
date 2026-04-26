/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool: web_fetch (runtime/tools/web.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Fetches a URL over HTTP(S) and returns a text body up to max_bytes.
 * Follows up to 5 redirects automatically. For text/html content, strips
 * tags/scripts/styles so the model sees readable text, not markup.
 * Returns structured { ok, status, url, final_url, content_type, bytes,
 * truncated, body }.
 * ───────────────────────────────────────────────────────────────────────── */
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

export const SCHEMA = {
  name: 'web_fetch',
  description: 'Fetch a URL (GET) and return text body up to 400KB. Follows up to 5 redirects. Strips HTML to plain text when content-type is text/html.',
  input_schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      timeout_ms: { type: 'number', default: 20000 },
      max_bytes: { type: 'number', default: 400_000 },
      keep_html: { type: 'boolean', default: false, description: 'If true, return raw HTML instead of text-stripped version.' },
    },
  },
};

function stripHtml(html) {
  // Very lightweight: drop script/style blocks, then tags, then decode a
  // handful of common entities. Not a full HTML-to-Markdown converter;
  // just enough so the model sees readable content.
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchOnce(url, { timeout_ms, max_bytes }) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, error: 'invalid_url' }; }
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request({
      host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'GET',
      headers: { 'user-agent': 'golduck/0.1', 'accept': 'text/html,text/plain,application/json,*/*' },
      timeout: timeout_ms,
    }, (res) => {
      const status = res.statusCode || 0;
      const ct = res.headers['content-type'] || '';
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ ok: false, redirect: res.headers.location, status });
      }
      let body = ''; let bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (c) => { bytes += c.length; if (bytes <= max_bytes) body += c; });
      res.on('end', () => resolve({ ok: status === 200, status, url: u.href, bytes, truncated: bytes > max_bytes, body, content_type: ct }));
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e) }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

export async function execute({ url, timeout_ms = 20000, max_bytes = 400_000, keep_html = false }) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const r = await fetchOnce(current, { timeout_ms, max_bytes });
    if (r.redirect) {
      // Resolve relative redirect against current URL.
      try { current = new URL(r.redirect, current).href; } catch { return { ok: false, error: 'bad_redirect' }; }
      continue;
    }
    if (!r.ok) return r;
    // Strip HTML if content-type indicates it (unless keep_html=true).
    const isHtml = /text\/html/i.test(r.content_type || '');
    if (isHtml && !keep_html) {
      r.body = stripHtml(r.body);
      r.content_type = (r.content_type || '') + '; stripped=true';
    }
    return { ...r, final_url: current };
  }
  return { ok: false, error: 'too_many_redirects' };
}
