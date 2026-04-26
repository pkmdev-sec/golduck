#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck native self-test (runtime/daemon/selftest.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Five-stage live smoke:
 *   1. doctor passes
 *   2. proxy /v1/models responds (mock models list)
 *   3. one-shot "ask" smoke → panel-critic approves a trivial fact
 *   4. engine tool_use smoke → `ls` + `read` with parallel dispatch
 *   5. verify CLI smoke on a synthetic Q/A pair
 *
 * Any failure → non-zero exit + clear remediation hint.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT  = process.env.REPO_ROOT || process.cwd();
const HOME  = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const GD    = join(ROOT, 'golduck', 'bin', 'golduck');

const GRN = '\x1b[32m'; const RED = '\x1b[31m'; const DIM = '\x1b[2m'; const RST = '\x1b[0m';

function step(msg) { console.log(`\n${DIM}▶ ${msg}${RST}`); }
function ok(msg)   { console.log(`  ${GRN}✓${RST} ${msg}`); }
function fail(msg, hint) { console.log(`  ${RED}✗${RST} ${msg}`); if (hint) console.log(`    ${DIM}${hint}${RST}`); process.exit(1); }

async function main() {
  step('doctor');
  const d = spawnSync(GD, ['doctor'], { encoding: 'utf8' });
  if (d.status !== 0) { console.log(d.stdout); fail('doctor failed', 'fix above issues'); }
  ok('doctor clean');

  step('proxy /healthz');
  try {
    const r = await fetch('http://127.0.0.1:8741/healthz');
    const b = await r.json();
    if (b.status !== 'ok') throw new Error(JSON.stringify(b));
    ok('proxy /healthz green');
  } catch (e) { fail(`/healthz probe failed: ${e.message}`); }

  step('native ask smoke (Opus 4.7 + verify)');
  const ask = spawnSync(GD, ['ask', '--quiet', 'Reply with exactly the single word: Pong'], {
    encoding: 'utf8', timeout: 180_000,
  });
  if (ask.status !== 0) { console.log(ask.stderr); fail('ask smoke failed'); }
  const out = (ask.stdout || '').trim();
  if (!/Pong/i.test(out)) fail(`expected 'Pong' in answer; got: "${out.slice(0,120)}"`);
  ok(`ask smoke — answer="${out.slice(0,80)}"`);

  step('engine tool_use smoke (parallel ls + read)');
  const run = spawnSync(GD, ['run', '--fast', '--budget', '10', '--',
    'Use the ls tool to list golduck/bin and the read tool to read golduck/bin/golduck (first 200 bytes). Reply with two lines: "COUNT=<n>" and "SHEBANG=<first line>".'],
    { encoding: 'utf8', timeout: 360_000 });
  if (run.status !== 0) { console.log(run.stdout); console.log(run.stderr); fail('run smoke failed'); }
  const rout = run.stdout || '';
  if (!/COUNT=/.test(rout)) fail(`run output missing COUNT=: ${rout.slice(-200)}`);
  if (!/SHEBANG=/.test(rout)) fail(`run output missing SHEBANG=: ${rout.slice(-200)}`);
  ok('run + parallel tool_use smoke passed');

  step('verify CLI smoke');
  const v = spawnSync(GD, ['verify', 'What is 2+2?', 'Four.'], { encoding: 'utf8', timeout: 60_000 });
  if (v.status !== 0) { console.log(v.stderr); fail('verify CLI failed'); }
  const parsed = JSON.parse(v.stdout);
  if (parsed.verdict !== 'approve') fail(`expected verdict=approve, got ${JSON.stringify(parsed)}`);
  ok(`verify panel approved (confidence=${parsed.confidence ?? '?'})`);

  console.log(`\n${GRN}ALL CHECKS PASSED${RST}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(99); });
