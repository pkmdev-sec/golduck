/* ─────────────────────────────────────────────────────────────────────────
 * golduck MCP stdio client (runtime/mcp/client.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * A small persistent MCP client per configured server. Speaks JSON-RPC
 * 2.0 over stdio. Used to wire obscura (headless browser) and any user-
 * registered MCP servers into the native tool loop.
 *
 * For each configured server we:
 *   1. spawn the stdio process (once, reused for the session)
 *   2. initialize + notifications/initialized
 *   3. list_tools → build a tool catalog we prefix-namespace per server
 *   4. on tool call: send tools/call and await the response
 *
 * Server config lives in $GOLDUCK_HOME/config/mcp.json:
 *   { "servers": {
 *       "obscura": { "command": "obscura-mcp", "args": [], "env": {} },
 *       "linear":  { "command": "linear-mcp", "args": [], "env": {} }
 *   } }
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const CONFIG_FILE = () => join(HOME(), 'config', 'mcp.json');

// Also auto-detect cxr-obscura if the launcher is present (common setup).
function detectAutoServers() {
  const out = {};
  const obs = join(homedir(), 'cxr-obscura', 'bin', 'obscura-mcp');
  if (existsSync(obs)) {
    out.obscura = { command: obs, args: [], env: {} };
  }
  return out;
}

function loadConfig() {
  const auto = detectAutoServers();
  if (!existsSync(CONFIG_FILE())) return { servers: auto };
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE(), 'utf8'));
    return { servers: { ...auto, ...(cfg.servers || {}) } };
  } catch { return { servers: auto }; }
}

export class MCPServer {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.ready = false;
    this.buf = '';
  }

  start() {
    if (this.proc) return;
    const env = { ...process.env, ...(this.config.env || {}) };
    this.proc = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => this._onData(c));
    this.proc.stderr.on('data', () => {}); // silence stderr
    // stdin can emit EPIPE when the child dies mid-write. Catching here
    // prevents the error from crashing the whole process; _onDeath will
    // still fire via the 'exit' event.
    this.proc.stdin.on('error', (e) => { try { this._onDeath({ err: e }); } catch {} });
    this.proc.on('exit', (code, signal) => this._onDeath({ code, signal }));
    this.proc.on('error', (err) => this._onDeath({ err }));
  }

  _onDeath(info) {
    this.ready = false;
    this.proc = null;
    this.lastDeath = { at: Date.now(), ...info };
    // Surface the death in the trace — the TUI's Mcp overlay shows it on next probe.
    try {
      // Best-effort trace write without an import cycle.
      const { event } = globalThis.__golduckTrace || {};
      if (typeof event === 'function') {
        event('mcp.server_died', { name: this.name, info: String(info?.signal || info?.code || info?.err || 'unknown').slice(0, 200) });
      }
    } catch {}
    // Reject any pending requests so callers see a clear error instead of hanging.
    for (const { reject } of this.pending.values()) {
      try { reject(new Error(`mcp ${this.name} died: ${info.signal || info.code || info.err || 'unknown'}`)); } catch {}
    }
    this.pending.clear();
  }

  _onData(c) {
    this.buf += c;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {}
    }
  }

  _send(method, params = undefined) {
    const id = this.nextId++;
    return new Promise(async (resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Auto-reconnect: if the stdio proc is dead or never started, attempt
      // one bounded restart + handshake before writing the frame. Prevents
      // "crashed server stays dead for the run" failure mode.
      if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
        try { await this._reconnect(); }
        catch (e) { this.pending.delete(id); return reject(e); }
      }
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try { this.proc.stdin.write(frame + '\n'); }
      catch (e) { this.pending.delete(id); return reject(e); }
      const toolTimeout = parseInt(process.env.GOLDUCK_MCP_TOOL_TIMEOUT_MS || '60000', 10);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mcp timeout: ${method} after ${toolTimeout}ms`));
        }
      }, toolTimeout);
    });
  }

  async _reconnect() {
    // Basic back-off: cap at 3 reconnects in any 60s window to avoid a
    // pathological crash loop pinning CPU.
    const now = Date.now();
    this._reconnectLog = (this._reconnectLog || []).filter((t) => now - t < 60_000);
    if (this._reconnectLog.length >= 3) {
      throw new Error(`mcp ${this.name} reconnect budget exhausted (3/60s)`);
    }
    this._reconnectLog.push(now);
    this.nextId = 1;
    this.buf = '';
    this.start();
    if (!this.proc) throw new Error(`failed to respawn ${this.name}`);
    // Re-do the MCP handshake minus tools/list (keep the cached this.tools).
    await this._send_raw('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'golduck', version: '0.1.0' },
    });
    this._notify('notifications/initialized');
    this.ready = true;
  }

  // Internal handshake _send that does not itself trigger a reconnect loop.
  _send_raw(method, params = undefined) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      try { this.proc.stdin.write(frame + '\n'); }
      catch (e) { this.pending.delete(id); return reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`mcp handshake timeout: ${method}`));
        }
      }, 15000);
    });
  }

  _notify(method, params = undefined) {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin.write(frame + '\n');
  }

  async initialize() {
    this.start();
    if (!this.proc) throw new Error(`failed to spawn ${this.name}`);
    // Handshake.
    await this._send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'golduck', version: '0.1.0' },
    });
    this._notify('notifications/initialized');
    // Discover tools.
    const r = await this._send('tools/list', {});
    this.tools = (r.result?.tools || []).map((t) => ({
      ...t,
      // prefix name with server namespace so the native catalog doesn't collide
      qualified_name: `${this.name}__${t.name}`,
    }));
    this.ready = true;
    return this.tools;
  }

  async callTool(localName, args) {
    const r = await this._send('tools/call', { name: localName, arguments: args });
    return r.result;
  }

  stop() {
    try { this.proc?.kill('SIGTERM'); } catch {}
    this.proc = null; this.ready = false;
  }
}

export async function loadAllMCP() {
  const { servers } = loadConfig();
  const out = {};
  for (const [name, config] of Object.entries(servers)) {
    try {
      const s = new MCPServer(name, config);
      await s.initialize();
      out[name] = s;
    } catch (e) {
      console.error(`[golduck mcp] ${name}: ${e.message}`);
    }
  }
  return out;
}
