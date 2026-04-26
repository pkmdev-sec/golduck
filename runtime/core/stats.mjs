#!/usr/bin/env node
/* golduck stats — aggregate metrics across recent runs. */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const TRACES = join(HOME, 'traces');

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function human(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n/1000).toFixed(1) + 'k';
  return (n/1_000_000).toFixed(2) + 'M';
}

function main() {
  if (!existsSync(TRACES)) { console.log('no traces yet'); return; }
  const files = readdirSync(TRACES).filter((f) => f.endsWith('.jsonl') && f !== 'current.jsonl')
    .map((f) => join(TRACES, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, 50);
  if (!files.length) { console.log('no traces yet'); return; }

  const perRun = [];
  for (const f of files) {
    const evs = readEvents(f);
    const run = { file: f, run_id: null, started: null, ended: null, input: 0, output: 0, cache_read: 0, cache_write: 0, tools: 0, tool_errors: 0, tool_latencies: [], verify: null };
    for (const e of evs) {
      run.run_id = run.run_id || e.run_id;
      if (e.name === 'trace.open') run.started = e.ts;
      if (e.name === 'trace.close') run.ended = e.ts;
      if (e.name === 'engine.response' && e.usage) {
        run.input += e.usage.input_tokens || 0;
        run.output += e.usage.output_tokens || 0;
        run.cache_read += e.usage.cache_read_input_tokens || 0;
        run.cache_write += e.usage.cache_creation_input_tokens || 0;
      }
      if (e.span === 'tool.call' && e.name !== 'span.exit') run.tools++;
      if (e.name === 'span.exit' && e.span === 'tool.call') {
        if (e.ok === false) run.tool_errors++;
        if (typeof e.duration_ms === 'number') run.tool_latencies.push(e.duration_ms);
      }
      if (e.name === 'verify.verdict') run.verify = e.verdict;
    }
    perRun.push(run);
  }
  const totals = perRun.reduce((a, r) => ({
    runs: a.runs + 1,
    input: a.input + r.input, output: a.output + r.output,
    cache_read: a.cache_read + r.cache_read, cache_write: a.cache_write + r.cache_write,
    tools: a.tools + r.tools, tool_errors: a.tool_errors + r.tool_errors,
    tool_latencies: a.tool_latencies.concat(r.tool_latencies),
  }), { runs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, tools: 0, tool_errors: 0, tool_latencies: [] });

  // Rough cost with Opus 4.7 pricing.
  const usd = (totals.input * 15 + totals.output * 75 + totals.cache_read * 1.5 + totals.cache_write * 18.75) / 1_000_000;

  console.log('golduck stats (last 50 runs):');
  console.log(`  runs:       ${totals.runs}`);
  console.log(`  input tok:  ${human(totals.input)}`);
  console.log(`  output tok: ${human(totals.output)}`);
  console.log(`  cache rd:   ${human(totals.cache_read)}`);
  console.log(`  cache wr:   ${human(totals.cache_write)}`);
  console.log(`  tools run:  ${totals.tools}  (errors: ${totals.tool_errors})`);
  console.log(`  ≈ spend:    $${usd.toFixed(4)}`);
  if (totals.tool_latencies.length) {
    const ls = totals.tool_latencies.sort((a,b)=>a-b);
    const pct = (p) => ls[Math.min(Math.floor(ls.length * p), ls.length - 1)];
    console.log(`  tool p50:   ${pct(0.5)}ms   p95:${pct(0.95)}ms   p99:${pct(0.99)}ms   max:${ls[ls.length-1]}ms`);
  }
  console.log();
  console.log('recent runs:');
  for (const r of perRun.slice(0, 10)) {
    const d = (r.input + r.output + r.cache_read + r.cache_write) || 0;
    console.log(`  ${(r.run_id || '?').slice(0, 12)}  ${r.started || '-'}  ${human(d).padStart(6)} tokens  verify=${r.verify || '-'}  tools=${r.tools}`);
  }
}
main();
