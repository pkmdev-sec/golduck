/* ─────────────────────────────────────────────────────────────────────────
 * golduck hook runner (runtime/engine/hooks.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * User hook scripts live in $GOLDUCK_HOME/hooks/.
 *
 *   pre_request_<name>    stdin = JSON {messages, system_bytes, model}   stdout = ignored (informational) or JSON {messages?}
 *   post_response_<name>  stdin = JSON {text, usage, stop_reason, run_id} stdout = ignored
 *   on_tool_<name>        stdin = JSON {tool, args}                     stdout = ignored
 *
 * Hooks run in parallel per event, with a 5s timeout each. If a
 * pre_request hook returns a JSON object on stdout with a `messages`
 * array, we replace the outgoing messages with it — simple mutation API.
 *
 * Any errors are logged to the trace but NEVER block the main loop.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { event } from '../trace/tracer.mjs';

function hooksDir() { return join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'hooks'); }

function listHooks(prefix) {
  const dir = hooksDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .map((n) => join(dir, n))
      .filter((f) => { try { return statSync(f).isFile(); } catch { return false; } });
  } catch { return []; }
}

function runHook(path, payload) {
  return new Promise((resolve) => {
    const ps = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '', err = '';
    ps.stdout.on('data', (c) => out += c.toString());
    ps.stderr.on('data', (c) => err += c.toString());
    const timer = setTimeout(() => { try { ps.kill('SIGTERM'); } catch {} }, 5000);
    ps.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ path, code, out: out.slice(0, 8000), err: err.slice(0, 2000) });
    });
    ps.on('error', (e) => { clearTimeout(timer); resolve({ path, code: 127, err: String(e) }); });
    try { ps.stdin.end(JSON.stringify(payload)); } catch {}
  });
}

/** Run every pre_request hook in parallel. If any returned JSON with
 *  `.messages`, use that as the new message list (last-wins). */
export async function runPreRequest({ messages, systemBytes, model }) {
  const hooks = listHooks('pre_request_');
  if (!hooks.length) return { messages };
  const payload = { messages, system_bytes: systemBytes, model };
  const results = await Promise.all(hooks.map((h) => runHook(h, payload)));
  let finalMessages = messages;
  for (const r of results) {
    event('hook.pre_request', { path: r.path, code: r.code });
    if (r.code === 0 && r.out) {
      try {
        const j = JSON.parse(r.out);
        if (j && Array.isArray(j.messages)) finalMessages = j.messages;
      } catch {}
    }
  }
  return { messages: finalMessages };
}

export async function runPostResponse({ text, usage, stop_reason, run_id }) {
  const hooks = listHooks('post_response_');
  if (!hooks.length) return;
  const payload = { text, usage, stop_reason, run_id };
  const results = await Promise.all(hooks.map((h) => runHook(h, payload)));
  for (const r of results) event('hook.post_response', { path: r.path, code: r.code });
}

export async function runOnTool({ tool, args }) {
  const hooks = listHooks('on_tool_');
  if (!hooks.length) return;
  const results = await Promise.all(hooks.map((h) => runHook(h, { tool, args })));
  for (const r of results) event('hook.on_tool', { path: r.path, code: r.code });
}
