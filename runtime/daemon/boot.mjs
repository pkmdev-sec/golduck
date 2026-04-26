#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck daemon boot (runtime/daemon/boot.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * The "single command spins up everything" orchestrator.
 *
 * Subcommands:
 *   up      — ensure all services are running and ready (idempotent, fast)
 *   down    — stop all golduck-managed services gracefully
 *   status  — print a dense JSON health report
 *
 * Managed services:
 *   1. Bedrock/Anthropic proxy (cxr's anthropic-proxy/proxy.mjs OR
 *      droid-reverse-engineered/droidx-runtime/proxy/proxy.mjs — both
 *      speak /v1/messages). Golduck prefers the cxr proxy since it's the
 *      upstream reference; droidx is started additionally only when a
 *      droid frontend session is requested.
 *   2. droidx-rlm MCP server (stdio — not long-running; started on-demand
 *      by clients, but we preflight `node --check` here to fail early).
 *   3. obscura MCP bridge preflight (similar — stdio).
 *   4. golduck orchestrator daemon (this process forks it).
 *
 * Health decisions:
 *   - proxy: /healthz 200 + /readyz green
 *   - daemon: pid file present AND process alive
 *   - mcp binaries: present + syntax-ok
 *
 * All health state lives under $GOLDUCK_HOME/state/.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

const GOLDUCK_HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const STATE = join(GOLDUCK_HOME, 'state');
const LOGS  = join(GOLDUCK_HOME, 'logs');
mkdirSync(STATE, { recursive: true });
mkdirSync(LOGS,  { recursive: true });

const CXR_PROXY_DIR    = process.env.CXR_PROXY_DIR;
const DROIDX_PROXY_DIR = process.env.DROIDX_PROXY_DIR;
const DROIDX_RLM_DIR   = process.env.DROIDX_RLM_DIR;
const OBSCURA_MCP_HOME = process.env.OBSCURA_MCP_HOME;

const CXR_PROXY_PORT    = parseInt(process.env.CXR_PROXY_PORT    || '8741', 10);
const DROIDX_PROXY_PORT = parseInt(process.env.DROIDX_PROXY_PORT || '8752', 10);
const DAEMON_PORT       = parseInt(process.env.GOLDUCK_DAEMON_PORT || '8787', 10);

const DAEMON_PID  = join(STATE, 'daemon.pid');
const DAEMON_LOG  = join(LOGS, 'daemon.log');
const CXR_PID     = join(STATE, 'cxr-proxy.pid');
const CXR_LOG     = join(LOGS, 'cxr-proxy.log');
const DROIDX_PID  = join(STATE, 'droidx-proxy.pid');
const DROIDX_LOG  = join(LOGS, 'droidx-proxy.log');

// ----- helpers -------------------------------------------------------------

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readPid(file) {
  try { const n = parseInt(readFileSync(file, 'utf8').trim(), 10); return Number.isFinite(n) ? n : null; } catch { return null; }
}
function writePid(file, pid) { writeFileSync(file, String(pid)); }
function removePid(file) { try { unlinkSync(file); } catch {} }

async function httpGet(port, path, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ status: 0, error: String(e) }));
    req.on('timeout', () => { try { req.destroy(); } catch {}; resolve({ status: 0, error: 'timeout' }); });
  });
}

async function proxyHealthz(port) { return (await httpGet(port, '/healthz')).status === 200; }
async function proxyReadyz(port) {
  const r = await httpGet(port, '/readyz', 4000);
  if (r.status !== 200) return { ready: false, body: r.body || r.error };
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch {}
  return { ready: Boolean(parsed && /valid/.test(r.body)), body: parsed || r.body };
}

function startCxrProxy() {
  if (!CXR_PROXY_DIR || !existsSync(join(CXR_PROXY_DIR, 'proxy.mjs'))) return { started: false, reason: 'cxr_proxy_missing' };
  const pid = readPid(CXR_PID);
  if (pid && alive(pid)) return { started: false, reason: 'already_running', pid };
  const env = { ...process.env, PROXY_PORT: String(CXR_PROXY_PORT) };
  const out = openSync(CXR_LOG, 'a');
  const child = spawn('node', [join(CXR_PROXY_DIR, 'proxy.mjs')], { env, stdio: ['ignore', out, out], detached: true });
  child.unref();
  writePid(CXR_PID, child.pid);
  return { started: true, pid: child.pid };
}

function startDroidxProxy() {
  if (!DROIDX_PROXY_DIR || !existsSync(join(DROIDX_PROXY_DIR, 'proxy.mjs'))) return { started: false, reason: 'droidx_proxy_missing' };
  const pid = readPid(DROIDX_PID);
  if (pid && alive(pid)) return { started: false, reason: 'already_running', pid };
  const env = { ...process.env, DROIDX_PROXY_PORT: String(DROIDX_PROXY_PORT) };
  const out = openSync(DROIDX_LOG, 'a');
  const child = spawn('node', [join(DROIDX_PROXY_DIR, 'proxy.mjs')], { env, stdio: ['ignore', out, out], detached: true });
  child.unref();
  writePid(DROIDX_PID, child.pid);
  return { started: true, pid: child.pid };
}

function waitReady(port, timeoutSec = 15) {
  const deadline = Date.now() + timeoutSec * 1000;
  return new Promise(async (resolve) => {
    while (Date.now() < deadline) {
      if (await proxyHealthz(port)) {
        const rz = await proxyReadyz(port);
        if (rz.ready) return resolve({ ready: true });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    resolve({ ready: false });
  });
}

function mcpPreflight() {
  const out = {};
  if (DROIDX_RLM_DIR) {
    const server = join(DROIDX_RLM_DIR, 'server.mjs');
    if (existsSync(server)) {
      const r = spawnSync('node', ['--check', server]);
      out.droidx_rlm = r.status === 0 ? 'ok' : 'syntax_error';
    } else out.droidx_rlm = 'missing';
  }
  if (OBSCURA_MCP_HOME) {
    const launcher = join(OBSCURA_MCP_HOME, 'bin', 'obscura-mcp');
    out.obscura = existsSync(launcher) ? 'ok' : 'missing';
  }
  return out;
}

// ----- subcommands ---------------------------------------------------------

async function up() {
  const report = { services: {} };

  // cxr proxy (primary, always up)
  const cxrHealth = await proxyHealthz(CXR_PROXY_PORT);
  if (!cxrHealth) {
    const s = startCxrProxy();
    report.services.cxr_proxy = s;
    await waitReady(CXR_PROXY_PORT, 20);
  } else report.services.cxr_proxy = { started: false, reason: 'already_healthy' };

  // droidx proxy (only needed if we'll route droid-mode; lazy start)
  // We start it anyway if GOLDUCK_BOOT_ALL=1. Cheap to run idle.
  if (process.env.GOLDUCK_BOOT_ALL === '1') {
    const dxH = await proxyHealthz(DROIDX_PROXY_PORT);
    if (!dxH) report.services.droidx_proxy = startDroidxProxy();
    else report.services.droidx_proxy = { started: false, reason: 'already_healthy' };
    await waitReady(DROIDX_PROXY_PORT, 15);
  }

  // MCP preflight (no start; validate presence)
  report.services.mcp = mcpPreflight();

  // Daemon (long-running orchestrator helper; optional, for tracer UI)
  const dPid = readPid(DAEMON_PID);
  if (!dPid || !alive(dPid)) {
    // Start the daemon in the background. It just holds state.
    const daemonEntry = join(process.env.GOLDUCK_ROOT, 'runtime', 'daemon', 'daemon_main.mjs');
    if (existsSync(daemonEntry)) {
      const out = openSync(DAEMON_LOG, 'a');
      const child = spawn('node', [daemonEntry], { stdio: ['ignore', out, out], detached: true, env: process.env });
      child.unref();
      writePid(DAEMON_PID, child.pid);
      report.services.daemon = { started: true, pid: child.pid };
    } else report.services.daemon = { started: false, reason: 'no_entry' };
  } else report.services.daemon = { started: false, reason: 'already_alive', pid: dPid };

  console.log(JSON.stringify(report, null, 2));
}

async function down() {
  const report = {};
  for (const [name, pidFile] of [
    ['daemon', DAEMON_PID], ['cxr_proxy', CXR_PID], ['droidx_proxy', DROIDX_PID],
  ]) {
    const pid = readPid(pidFile);
    if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      // Give 2s for graceful shutdown.
      await new Promise((r) => setTimeout(r, 1500));
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      removePid(pidFile);
      report[name] = { stopped: true, pid };
    } else {
      report[name] = { stopped: false, reason: 'not_running' };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

export async function collectStatus() {
  const out = { services: {} };
  const cxrH = await proxyHealthz(CXR_PROXY_PORT);
  const cxrR = cxrH ? await proxyReadyz(CXR_PROXY_PORT) : { ready: false };
  out.services.cxr_proxy = { port: CXR_PROXY_PORT, pid: readPid(CXR_PID), healthz: cxrH, readyz: cxrR.ready };
  const dxH  = await proxyHealthz(DROIDX_PROXY_PORT);
  const dxR  = dxH ? await proxyReadyz(DROIDX_PROXY_PORT) : { ready: false };
  out.services.droidx_proxy = { port: DROIDX_PROXY_PORT, pid: readPid(DROIDX_PID), healthz: dxH, readyz: dxR.ready };
  out.services.daemon = { pid: readPid(DAEMON_PID), alive: Boolean(readPid(DAEMON_PID) && alive(readPid(DAEMON_PID))) };
  out.services.mcp = mcpPreflight();
  out.home = GOLDUCK_HOME;
  out.traces = {};
  try {
    const tDir = join(GOLDUCK_HOME, 'traces');
    const files = readdirSync(tDir).filter((n) => n.endsWith('.jsonl')).sort().slice(-5);
    out.traces.recent = files;
  } catch {}
  return out;
}

async function status() {
  const out = await collectStatus();
  console.log(JSON.stringify(out, null, 2));
}

// Only run the CLI dispatcher when invoked directly (`node boot.mjs up`),
// not when this module is imported by other runtime code (e.g. the TUI
// doctor overlay calling `collectStatus()`).
const isMain = import.meta.url === `file://${process.argv[1]}`
  || (process.argv[1] && process.argv[1].endsWith('/boot.mjs'));
if (isMain) {
  const cmd = process.argv[2];
  (async () => {
    if (cmd === 'up')      await up();
    else if (cmd === 'down')   await down();
    else if (cmd === 'status') await status();
    else { console.error('usage: boot.mjs up|down|status'); process.exit(2); }
  })().catch((e) => { console.error(e); process.exit(99); });
}
