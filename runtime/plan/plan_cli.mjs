#!/usr/bin/env node
/* Native golduck plan CLI. Calls uncertain_so_recurse. */
import { uncertain_so_recurse } from '../tools/rlm.mjs';

async function main() {
  const goal = process.argv.slice(2).join(' ');
  if (!goal) { console.error('usage: golduck plan "<goal>"'); process.exit(2); }
  const out = await uncertain_so_recurse({ question: goal, uncertainty_reason: 'golduck plan — autonomous decomposition request' });
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error('[plan] ' + (e?.message || e)); process.exit(99); });
