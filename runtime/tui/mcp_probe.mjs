/* ─────────────────────────────────────────────────────────────────────────
 * golduck MCP probe (runtime/tui/mcp_probe.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Briefly spawns every configured MCP server, asks it for `tools/list`,
 * records the count, then kills it. Results are cached to
 * `$GOLDUCK_HOME/tmp/mcp-probe.json` so the /mcp overlay can display live
 * tool counts without paying the spawn cost on every render.
 *
 * Budget: 3s total, 1s per server. Flaky servers are dropped gracefully;
 * this module never throws.
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { MCPServer } from '../mcp/client.mjs';
import { event } from '../trace/tracer.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const CACHE_FILE = () => join(HOME(), 'tmp', 'mcp-probe.json');
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const TOTAL_BUDGET_MS = 3000;
const PER_SERVER_BUDGET_MS = 1000;

// We deliberately skip `loadAllMCP` here: it serializes servers and has a
// 60s per-request timeout baked in. For a probe we need a tight overall
// budget, so we reuse `MCPServer` but drive discovery ourselves. Keep the
// config layout in sync with client.mjs.
function detectAutoServers() {
  const out = {};
  const obs = join(homedir(), 'cxr-obscura', 'bin', 'obscura-mcp');
  try {
    if (existsSync(obs)) out.obscura = { command: obs, args: [], env: {} };
  } catch {}
  return out;
}

function loadConfig() {
  const auto = detectAutoServers();
  const cfgPath = join(HOME(), 'config', 'mcp.json');
  try {
    if (!existsSync(cfgPath)) return { servers: auto };
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    return { servers: { ...auto, ...(cfg.servers || {}) } };
  } catch {
    return { servers: auto };
  }
}

function withTimeout(promise, ms, onTimeoutMsg) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ ok: false, error: onTimeoutMsg });
    }, ms);
    promise.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || String(e) });
      },
    );
  });
}

async function probeOne(name, config, budgetMs) {
  const server = new MCPServer(name, config);
  const run = (async () => {
    try {
      const tools = await server.initialize();
      return { ok: true, tool_count: Array.isArray(tools) ? tools.length : 0 };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  })();
  const res = await withTimeout(run, budgetMs, `timeout after ${budgetMs}ms`);
  try { server.stop(); } catch {}
  if (res.ok) return { name, ok: true, tool_count: res.tool_count };
  return { name, ok: false, tool_count: 0, error: res.error };
}

function writeCache(result) {
  try {
    const path = CACHE_FILE();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(result, null, 2));
  } catch {}
}

export async function probeAllMcp() {
  const started = Date.now();
  let servers = {};
  try {
    servers = loadConfig().servers || {};
  } catch {
    servers = {};
  }
  try { event('mcp.probe.start', { count: Object.keys(servers).length }); } catch {}

  const entries = Object.entries(servers);
  const results = await Promise.all(
    entries.map(([name, config]) => {
      const remaining = Math.max(0, TOTAL_BUDGET_MS - (Date.now() - started));
      const budget = Math.min(PER_SERVER_BUDGET_MS, remaining || PER_SERVER_BUDGET_MS);
      return probeOne(name, config, budget).catch((e) => ({
        name,
        ok: false,
        tool_count: 0,
        error: e?.message || String(e),
      }));
    }),
  );

  // Enforce the overall budget: any probe that hasn't finished by now
  // would have been handled by its per-server timeout, but we also drop
  // servers that clearly blew the budget (defensive — shouldn't happen
  // since Promise.all already awaits per-server timeouts).
  const elapsed = Date.now() - started;
  const filtered = elapsed > TOTAL_BUDGET_MS + 500
    ? results.filter((r) => r.ok)
    : results;

  const out = {
    ts: new Date().toISOString(),
    servers: filtered,
  };
  writeCache(out);
  try { event('mcp.probe.done', { duration_ms: elapsed, servers: filtered.length }); } catch {}
  return out;
}

export function readCachedProbe() {
  try {
    const path = CACHE_FILE();
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (Date.now() - st.mtimeMs > CACHE_MAX_AGE_MS) return null;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || !Array.isArray(data.servers)) return null;
    return data;
  } catch {
    return null;
  }
}
