/* golduck budget ledger (runtime/memory/budget.mjs)
 * POSTs spend to the daemon (if up) and/or writes to the cost file.
 * Safe to call concurrently: writes are best-effort. */
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

async function rotateJournals(home) {
  const { readdirSync, readFileSync: rf, writeFileSync: wf, existsSync: ex, statSync } = await import('node:fs');
  const { join: jn } = await import('node:path');
  const limit = parseInt(process.env.GOLDUCK_JOURNAL_MAX_LINES || '5000', 10);
  if (limit <= 0) return;
  const memDir = jn(home, 'memory');
  if (!ex(memDir)) return;
  for (const name of readdirSync(memDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const p = jn(memDir, name);
    try {
      // Cheap: only scan when file > 1MB, and only rewrite if line count exceeds limit * 1.5.
      if (statSync(p).size < 1_000_000) continue;
      const raw = rf(p, 'utf8');
      const lines = raw.split('\n');
      if (lines.length <= limit * 1.5) continue;
      const kept = lines.slice(-limit).join('\n');
      wf(p, kept);
    } catch { /* best-effort */ }
  }
  // Session rotation: keep only the last N .json session files.
  const sessDir = jn(home, 'state', 'sessions');
  if (!ex(sessDir)) return;
  const sessLimit = parseInt(process.env.GOLDUCK_SESSION_KEEP || '50', 10);
  if (sessLimit <= 0) return;
  try {
    const files = readdirSync(sessDir).filter((f) => f.endsWith('.json'));
    if (files.length <= sessLimit) return;
    const withMtime = files.map((f) => ({ f, m: statSync(jn(sessDir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    const toDelete = withMtime.slice(sessLimit).map((x) => x.f);
    const { unlinkSync } = await import('node:fs');
    for (const f of toDelete) { try { unlinkSync(jn(sessDir, f)); } catch {} }
  } catch { /* best-effort */ }
}

export async function recordSpend({ runId, home, code, usd = 0 }) {
  const H = home || process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const P = parseInt(process.env.GOLDUCK_DAEMON_PORT || '8787', 10);

  // Try daemon first.
  try {
    await new Promise((resolve) => {
      const body = JSON.stringify({ usd, run_id: runId });
      // Read the shared-secret the daemon wrote at boot; ignore if missing (auth check will 401 but we also fsync below).
      let token = '';
      try {
        const tokenPath = join(H, 'state', 'daemon.token');
        token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '';
      } catch {}
      const req = http.request({ host: '127.0.0.1', port: P, path: '/spend', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { 'x-golduck-token': token } : {}) }, timeout: 1500 },
        (res) => { res.on('data', () => {}); res.on('end', resolve); });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch {}; resolve(null); });
      req.write(body); req.end();
    });
  } catch {}

  // Fallback / always: fsync to disk (daemon does this too, but duplicative writes are cheap).
  try {
    // Opportunistic rotation of unbounded JSONL journals so disk usage stays sane.
    // Honors GOLDUCK_JOURNAL_MAX_LINES (default 5000 per file).
    try { await rotateJournals(H); } catch {}
    const costFile = join(H, 'memory', 'cost.json');
    mkdirSync(dirname(costFile), { recursive: true });
    let j = { session_usd: 0, lifetime_usd: 0 };
    if (existsSync(costFile)) { try { j = JSON.parse(readFileSync(costFile, 'utf8')); } catch {} }
    j.session_usd  = (j.session_usd  || 0) + (parseFloat(usd) || 0);
    j.lifetime_usd = (j.lifetime_usd || 0) + (parseFloat(usd) || 0);
    writeFileSync(costFile, JSON.stringify(j, null, 2));
    return j;
  } catch { return null; }
}
