#!/usr/bin/env node
/* Native golduck verify CLI. Calls rlm_verify on a question+answer pair. */
import { rlm_verify } from '../tools/rlm.mjs';
import { readFileSync } from 'node:fs';

function parseArgv(argv) {
  const out = { q: null, a: null, qf: null, af: null };
  const args = [...argv];
  while (args.length) {
    const x = args.shift();
    if (x === '--question-file') out.qf = args.shift();
    else if (x === '--answer-file') out.af = args.shift();
    else if (!out.q) out.q = x;
    else if (!out.a) out.a = x;
  }
  return out;
}

async function main() {
  const cli = parseArgv(process.argv.slice(2));
  const q = cli.qf ? readFileSync(cli.qf, 'utf8') : (cli.q || '');
  const a = cli.af ? readFileSync(cli.af, 'utf8') : (cli.a || '');
  if (!q || !a) {
    console.error('usage: golduck verify "<question>" "<answer>" OR --question-file F --answer-file F');
    process.exit(2);
  }
  const out = await rlm_verify({ question: q.slice(0, 4000), answer: a.slice(0, 20000), model: 'opus' });
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('[verify] ' + (e?.message || e)); process.exit(99); });
