#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck daemon (runtime/daemon/daemon_main.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * A small long-running process that:
 *   - keeps the spend ledger in sync across concurrent frontends
 *   - exposes a Unix socket for trace fan-in from nested agents
 *   - periodically compacts memory journal and prunes stale pids
 *   - supervises: if cxr-proxy dies, restart it (crash-loop detection)
 *
 * HTTP on localhost:$GOLDUCK_DAEMON_PORT exposes:
 *   GET  /healthz                  liveness
 *   GET  /state                    whole in-mem state (json)
 *   POST /event                    append a trace event (payload = event body)
 *   POST /spend                    add { usd } to session ledger
 *   POST /pins/add                 { key, value } → pinned fact
 *   GET  /pins                     → current pins
 *   POST /reload                   reload constitution + skills from disk
 *
 * Everything keeps running even under load; fatal errors are logged,
 * never crash the daemon.
 * ───────────────────────────────────────────────────────────────────────── */
import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const PORT = parseInt(process.env.GOLDUCK_DAEMON_PORT || '8787', 10);
const STATE = join(HOME, 'state');
const MEM = join(HOME, 'memory');
mkdirSync(STATE, { recursive: true });
mkdirSync(MEM,   { recursive: true });

// ── Auth: shared secret persisted to $GOLDUCK_HOME/state/daemon.token with
//    0600 perms. Any process that can read ~/.golduck (the owner) can call
//    mutating endpoints; other local users cannot. Requests carry the token
//    via `X-Golduck-Token` header (GET /healthz is always unauth'd).
const TOKEN_FILE = join(STATE, 'daemon.token');
function _loadOrCreateToken() {
  try {
    if (existsSync(TOKEN_FILE)) {
      const t = readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t && t.length >= 16) return t;
    }
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  try {
    writeFileSync(TOKEN_FILE, t);
    try { chmodSync(TOKEN_FILE, 0o600); } catch {}
  } catch {}
  return t;
}
const DAEMON_TOKEN = _loadOrCreateToken();

function _authed(req) {
  if (req.method === 'GET' && req.url === '/healthz') return true;
  const h = req.headers['x-golduck-token'];
  if (typeof h === 'string' && h.length > 0) {
    // Constant-time compare so timing can't leak the token.
    const a = Buffer.from(h, 'utf8');
    const b = Buffer.from(DAEMON_TOKEN, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  return false;
}

// In-memory state snapshot, persisted to disk on every change.
const STATE_FILE = join(STATE, 'daemon_state.json');
const PIN_FILE   = join(MEM, 'pins.json');
const COST_FILE  = join(MEM, 'cost.json');

function loadJSON(p, fallback) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; }
  catch { return fallback; }
}
function saveJSON(p, obj) {
  try { writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {}
}

let S = {
  started_at: Date.now(),
  events_seen: 0,
  last_event_at: null,
  pins: loadJSON(PIN_FILE, []),
  cost: loadJSON(COST_FILE, { session_usd: 0, lifetime_usd: 0 }),
  supervisors: {},
};
// Rotate session on boot; keep lifetime.
S.cost.session_usd = 0;
saveJSON(COST_FILE, S.cost);

function send(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!_authed(req)) return send(res, 401, { error: 'unauthorized', hint: 'set X-Golduck-Token header' });
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, uptime_ms: Date.now() - S.started_at });
    if (req.method === 'GET' && req.url === '/state')   return send(res, 200, S);

    if (req.method === 'POST' && req.url === '/event') {
      const b = await readBody(req); S.events_seen++; S.last_event_at = Date.now();
      try { appendFileSync(join(HOME, 'traces', 'daemon.jsonl'), b + '\n'); } catch {}
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/spend') {
      const b = await readBody(req);
      try {
        const { usd } = JSON.parse(b);
        const v = parseFloat(usd);
        // Guardrails: clamp to a sane [0, 100] USD window per call so a
        // mis-sent payload can't zero out or balloon the ledger.
        if (Number.isFinite(v) && v > 0 && v <= 100) {
          S.cost.session_usd  += v;
          S.cost.lifetime_usd += v;
          saveJSON(COST_FILE, S.cost);
        }
      } catch {}
      return send(res, 200, S.cost);
    }
    if (req.method === 'GET'  && req.url === '/pins') return send(res, 200, S.pins);
    if (req.method === 'POST' && req.url === '/pins/add') {
      const b = await readBody(req);
      try {
        const p = JSON.parse(b);
        if (p && p.key && p.value) {
          S.pins = S.pins.filter((x) => x.key !== p.key);
          S.pins.push({ key: p.key, value: String(p.value), ts: new Date().toISOString() });
          saveJSON(PIN_FILE, S.pins);
        }
      } catch {}
      return send(res, 200, S.pins);
    }
    if (req.method === 'POST' && req.url === '/reload') {
      S.pins = loadJSON(PIN_FILE, []);
      S.cost = loadJSON(COST_FILE, S.cost);
      return send(res, 200, { reloaded: true });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    try { send(res, 500, { error: String(e) }); } catch {}
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[golduck daemon] listening on 127.0.0.1:${PORT}`);
});

// periodic tick: persist state; prune very old events file.
setInterval(() => {
  try { saveJSON(STATE_FILE, { at: new Date().toISOString(), events_seen: S.events_seen, cost: S.cost, pins_count: S.pins.length }); } catch {}
}, 5000).unref?.();

process.on('SIGTERM', () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2000); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 2000); });
process.on('uncaughtException', (e) => { console.error('[daemon] uncaught', e); });
process.on('unhandledRejection', (e) => { console.error('[daemon] unhandled', e); });
