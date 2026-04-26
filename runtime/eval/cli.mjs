#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
 * golduck eval CLI (runtime/eval/cli.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Usage:
 *   golduck eval                   # run full golden set (12 prompts)
 *   golduck eval --tier easy       # run only one tier (easy|medium|hard)
 *   golduck eval --tier medium,hard
 *   golduck eval --quiet           # no per-item printing
 *   golduck eval --diff            # skip run, diff the 2 most recent reports
 *   golduck eval --list            # list golden prompts + tiers
 *   golduck eval --wave <label>    # override wave label (default: $GOLDUCK_WAVE)
 * ───────────────────────────────────────────────────────────────────────── */

import { runEval, diffReports, loadRecentReports } from './runner.mjs';
import { GOLDEN, byTier, tiers } from './golden.mjs';

function parseArgs(argv) {
  const args = { tiers: null, verbose: true, diff: false, list: false, wave: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tier' || a === '-t') {
      args.tiers = String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    } else if (a === '--quiet' || a === '-q') {
      args.verbose = false;
    } else if (a === '--diff') {
      args.diff = true;
    } else if (a === '--list') {
      args.list = true;
    } else if (a === '--wave') {
      args.wave = argv[++i];
    } else if (a === '-h' || a === '--help') {
      console.log('golduck eval — run golden-set regression eval against Opus 4.7');
      console.log('usage: golduck eval [--tier easy|medium|hard] [--diff] [--list] [--quiet] [--wave <label>]');
      process.exit(0);
    }
  }
  return args;
}

function fmt(n, w = 6) { return String(n).padStart(w); }
function pct(r) { return (r * 100).toFixed(0) + '%'; }

function printReport(r) {
  console.log();
  console.log('── eval totals ─────────────────────────────────────────');
  console.log(`  wave:         ${r.wave}`);
  console.log(`  model:        ${r.model}`);
  console.log(`  prompts:      ${r.totals.n} (${r.totals.scored} scored)`);
  console.log(`  mean score:   ${r.totals.mean_score.toFixed(3)}`);
  console.log(`  approve rate: ${pct(r.totals.approve_rate)}`);
  console.log(`  revise rate:  ${pct(r.totals.revise_rate)}`);
  console.log(`  spend:        $${r.totals.usd.toFixed(4)}`);
  console.log(`  wall:         ${(r.totals.wall_ms / 1000).toFixed(1)}s`);
  if (r._file) console.log(`  report:       ${r._file}`);
}

function printDiff(d) {
  if (d.error) { console.log(`diff: ${d.error}`); return; }
  console.log();
  console.log('── eval diff (older → newer) ───────────────────────────');
  console.log(`  mean: ${d.from_mean.toFixed(3)} → ${d.to_mean.toFixed(3)}  (Δ ${d.delta_mean >= 0 ? '+' : ''}${d.delta_mean.toFixed(3)})`);
  if (d.improved.length) {
    console.log(`  improved (${d.improved.length}):`);
    for (const r of d.improved) console.log(`    ${r.id}: ${r.from.toFixed(2)} → ${r.to.toFixed(2)}`);
  }
  if (d.regressed.length) {
    console.log(`  regressed (${d.regressed.length}):`);
    for (const r of d.regressed) console.log(`    ${r.id}: ${r.from.toFixed(2)} → ${r.to.toFixed(2)}`);
  }
  if (!d.improved.length && !d.regressed.length) console.log('  no movement beyond the 0.05 threshold');
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    console.log(`${GOLDEN.length} golden prompts across tiers: ${tiers().join(', ')}`);
    for (const g of GOLDEN) {
      console.log(`  ${g.id.padEnd(5)} [${g.tier.padEnd(6)}]  ${g.prompt.slice(0, 80)}${g.prompt.length > 80 ? '…' : ''}`);
    }
    return;
  }

  if (args.diff) {
    const recent = loadRecentReports(2);
    if (recent.length < 2) { console.log('need at least 2 prior reports to diff'); return; }
    // loadRecentReports returns newest-first; diff(older, newer).
    printDiff(diffReports(recent[1], recent[0]));
    return;
  }

  if (args.wave) process.env.GOLDUCK_WAVE = args.wave;

  if (args.verbose) {
    console.log('golduck eval — running golden set against Opus 4.7');
    console.log(`tiers: ${args.tiers ? args.tiers.join(', ') : 'all'}`);
    console.log();
  }

  const report = await runEval({ tiers: args.tiers, verbose: args.verbose });
  printReport(report);

  const prior = loadRecentReports(2);
  if (prior.length >= 2) {
    printDiff(diffReports(prior[1], prior[0]));
  }
}

main().catch((e) => {
  console.error('eval failed:', e?.message || e);
  process.exit(1);
});
