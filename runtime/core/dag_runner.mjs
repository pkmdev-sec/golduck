#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck DAG runner (runtime/core/dag_runner.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Executes a JSON DAG file against the droidx-rlm MCP server. Nodes may
 * reference RLM tools (rlm_query, rlm_verify, coordinate, skill_invoke,
 * memory_set, brief_generate, ...). Dependencies express execution order.
 *
 * DAG schema (minimal):
 *   { "name": "my-plan", "nodes": [
 *       {"id":"a","tool":"brief_generate","args":{"role":"agent"}},
 *       {"id":"b","tool":"rlm_query","args":{"context":"@a","query":"..."},"deps":["a"]},
 *       {"id":"c","tool":"rlm_verify","args":{"question":"...","answer":"@b"},"deps":["b"]}
 *     ]
 *   }
 *
 * `@<id>` in any string arg resolves to the upstream node's textual
 * result (flattened with best-effort: .answer → .raw → JSON).
 * ───────────────────────────────────────────────────────────────────────── */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { event as traceEvent } from '../trace/tracer.mjs';

const NODE = process.env.NODE_BIN || 'node';
const SERVER = process.env.DROIDX_RLM_DIR ? join(process.env.DROIDX_RLM_DIR, 'server.mjs') : null;

function argvNext(a, i) { return a[i+1]; }

/* ─── live status writer ─────────────────────────────────────────────── */
function resolveStatePath(runId) {
  try {
    const home = process.env.GOLDUCK_HOME || join(homedir() || '', '.golduck');
    if (!home) return null;
    return join(home, 'state', 'dag', `${runId}.json`);
  } catch { return null; }
}

function createStatusWriter(runId, steps) {
  const path = resolveStatePath(runId);
  const state = { run_id: runId, steps };
  let lastWrite = 0;
  let dirty = false;

  const flush = (force = false) => {
    if (!path) return;
    const now = Date.now();
    if (!force && now - lastWrite < 100) { dirty = true; return; }
    lastWrite = now;
    dirty = false;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state, null, 2));
    } catch { /* never crash the run on disk errors */ }
  };

  return {
    runId,
    state,
    byId: new Map(steps.map((s) => [s.id, s])),
    write: flush,
    finalize: () => { if (dirty) flush(true); },
  };
}

function nowIso() { return new Date().toISOString(); }

async function callMCP(tool, args, waitSec = 60) {
  if (!SERVER || !existsSync(SERVER)) return { error: 'rlm_server_missing' };
  return new Promise((resolve) => {
    const proc = spawn(NODE, [SERVER], { stdio: ['pipe','pipe','ignore'], env: process.env });
    let buf = '';
    proc.stdout.on('data', (c) => buf += c.toString());
    const frames = [
      { jsonrpc:'2.0',id:1,method:'initialize',params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'golduck-dag',version:'1'} } },
      { jsonrpc:'2.0',method:'notifications/initialized' },
      { jsonrpc:'2.0',id:2,method:'tools/call',params:{ name:tool, arguments:args } },
    ];
    for (const f of frames) { proc.stdin.write(JSON.stringify(f) + '\n'); }
    const timer = setTimeout(() => {
      try { proc.stdin.end(); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 2000);
    }, waitSec * 1000);
    proc.on('exit', () => {
      clearTimeout(timer);
      for (const line of buf.split('\n')) {
        try {
          const o = JSON.parse(line);
          if (o.id === 2) {
            const txt = ((o.result && o.result.content) || [{}])[0].text || '';
            try { return resolve(JSON.parse(txt)); }
            catch { return resolve({ raw: txt }); }
          }
        } catch {}
      }
      resolve({ error: 'no_result' });
    });
  });
}

function resolveArg(v, results) {
  if (typeof v === 'string' && v.startsWith('@')) {
    const id = v.slice(1);
    const r = results[id];
    if (!r) return '';
    return r.answer || r.raw || JSON.stringify(r);
  }
  if (Array.isArray(v)) return v.map((x) => resolveArg(x, results));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k,vv] of Object.entries(v)) out[k] = resolveArg(vv, results);
    return out;
  }
  return v;
}

async function run(dag) {
  const results = {};
  const runId = process.env.GOLDUCK_RUN_ID || randomUUID().slice(0, 12);
  const steps = (dag.nodes || []).map((n) => ({
    id: n.id,
    title: n.title || n.name || n.id,
    status: 'pending',
  }));
  const status = createStatusWriter(runId, steps);
  status.write(true);
  traceEvent('dag.run.start', { run_id: runId, count: steps.length });
  const completed = new Set();
  const pending = [...dag.nodes];
  while (pending.length) {
    const ready = pending.filter((n) => (n.deps || []).every((d) => completed.has(d)));
    if (!ready.length) {
      for (const n of pending) {
        const s = status.byId.get(n.id);
        if (s) { s.status = 'blocked'; s.ended = nowIso(); }
      }
      status.write(true);
      traceEvent('dag.run.error', { run_id: runId, reason: 'unresolvable_deps' });
      throw new Error('unresolvable deps in DAG');
    }
    // Run ready nodes in parallel.
    await Promise.all(ready.map(async (n) => {
      const args = resolveArg(n.args || {}, results);
      console.error(`[dag] ▶ ${n.id} (${n.tool})`);
      const s = status.byId.get(n.id);
      if (s) { s.status = 'running'; s.started = nowIso(); }
      status.write();
      traceEvent('dag.step.start', { run_id: runId, id: n.id, tool: n.tool });
      try {
        const r = await callMCP(n.tool, args, n.wait_sec || 60);
        results[n.id] = r;
        completed.add(n.id);
        if (s) {
          s.ended = nowIso();
          if (r && r.error) {
            s.status = 'blocked';
            s.notes = String(r.error);
            traceEvent('dag.step.error', { run_id: runId, id: n.id, error: String(r.error) });
          } else {
            s.status = 'ok';
            traceEvent('dag.step.end', { run_id: runId, id: n.id });
          }
        }
      } catch (err) {
        if (s) { s.status = 'blocked'; s.ended = nowIso(); s.notes = String(err && err.message || err); }
        traceEvent('dag.step.error', { run_id: runId, id: n.id, error: String(err && err.message || err) });
        throw err;
      } finally {
        status.write();
      }
    }));
    for (const n of ready) {
      const i = pending.indexOf(n);
      if (i >= 0) pending.splice(i, 1);
    }
  }
  status.finalize();
  traceEvent('dag.run.end', { run_id: runId });
  return results;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: golduck dag <path-or-name>'); process.exit(2); }
  let path = arg;
  if (!existsSync(path)) {
    const built = join(process.env.GOLDUCK_ROOT || '', 'dags', arg + '.json');
    if (existsSync(built)) path = built;
    else {
      const drx = join(process.env.REPO_ROOT || '', 'droid-reverse-engineered', 'droidx-runtime', 'dags', arg + '.json');
      if (existsSync(drx)) path = drx;
    }
  }
  if (!existsSync(path)) { console.error('DAG not found:', arg); process.exit(2); }
  const dag = JSON.parse(readFileSync(path, 'utf8'));
  const results = await run(dag);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(99); });
