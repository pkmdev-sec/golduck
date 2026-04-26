/* ─────────────────────────────────────────────────────────────────────────
 * Spend overlay — session + lifetime budget ledger.
 * ─────────────────────────────────────────────────────────────────────────
 * Reads $GOLDUCK_HOME/memory/cost.json (written by runtime/memory/budget.mjs
 * and the daemon's /spend endpoint). Two-section card:
 *   1. Totals — session $, lifetime $, with budget-threshold colorization.
 *   2. Top spending runs — fixed-column table (runId · code · usd · since).
 * Colors spend yellow at >=60% of GOLDUCK_BUDGET_USD, red at >=90%.
 * Polls every 2000ms. Parent handles esc.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;
const REFRESH_MS = 2000;

function costFilePath() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  return join(HOME, 'memory', 'cost.json');
}

function loadCost() {
  const f = costFilePath();
  if (!existsSync(f)) return { missing: true };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return {
      missing: false,
      session_usd:  Number(j.session_usd)  || 0,
      lifetime_usd: Number(j.lifetime_usd) || 0,
      history: Array.isArray(j.history) ? j.history : [],
    };
  } catch (e) {
    return { missing: false, error: e?.message || String(e) };
  }
}

function sinceStr(ts) {
  if (!ts) return '—';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '—';
  const delta = Math.max(0, Date.now() - t);
  const s = Math.floor(delta / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24)  return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function budgetColor(used, budget) {
  if (!(budget > 0) || !Number.isFinite(budget)) return undefined;
  const r = used / budget;
  if (r >= 0.9) return COLORS.error;
  if (r >= 0.6) return COLORS.warn;
  return undefined;
}

export function Spend({ onClose, hasTTY }) {
  const [data, setData] = useState(() => loadCost());

  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) setData(loadCost()); };
    const id = setInterval(tick, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useInput((_ch, key) => { if (key.escape) onClose?.(); }, { isActive: Boolean(hasTTY) });

  const rawBudget = parseFloat(process.env.GOLDUCK_BUDGET_USD || 'Infinity');
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : Infinity;
  const budgetStr = Number.isFinite(budget) ? `$${budget.toFixed(2)}` : 'unlimited';
  const footer = `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s · budget=${budgetStr}`;

  if (data.missing) {
    return h(OverlayFrame, { title: `${GLYPH.diamond} spend`, footer },
      h(Text, { dimColor: true, italic: true },
        '(no cost ledger yet — first turn will create it)'),
    );
  }
  if (data.error) {
    return h(OverlayFrame, { title: `${GLYPH.diamond} spend`, footer },
      h(Text, { color: COLORS.error }, `failed to read cost.json: ${data.error}`),
    );
  }

  const history = data.history || [];
  const oldestTs = history.length
    ? history.reduce((m, r) => {
        const t = typeof r.ts === 'number' ? r.ts : Date.parse(r.ts);
        return Number.isFinite(t) && (m === null || t < m) ? t : m;
      }, null)
    : null;

  const sessionColor  = budgetColor(data.session_usd,  budget);
  const lifetimeColor = budgetColor(data.lifetime_usd, budget);

  let sessionRunId = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r && r.runId && (Number(r.usd) || 0) > 0) { sessionRunId = r.runId; break; }
  }

  const topRecent = history
    .slice(-20)
    .slice()
    .sort((a, b) => (Number(b.usd) || 0) - (Number(a.usd) || 0))
    .slice(0, 8);

  const chipParts = [`$${data.session_usd.toFixed(4)} session`, `$${data.lifetime_usd.toFixed(4)} lifetime`];
  const title = `${GLYPH.diamond} spend · ${chipParts.join(' · ')}`;

  return h(OverlayFrame, { title, footer },
    h(Text, { color: COLORS.brand, bold: true }, 'Totals'),
    h(Box, null,
      h(Box, { width: 2 }, h(Text, null, ' ')),
      h(Box, { width: 14 },
        h(Text, { bold: true, color: sessionColor }, `$${data.session_usd.toFixed(4)}`),
      ),
      h(Box, { width: 10 }, h(Text, { dimColor: true }, 'session')),
      h(Box, { flexGrow: 1 },
        h(Text, { dimColor: true }, `since ${oldestTs ? sinceStr(oldestTs) : '—'}`),
      ),
    ),
    h(Box, null,
      h(Box, { width: 2 }, h(Text, null, ' ')),
      h(Box, { width: 14 },
        h(Text, { bold: true, color: lifetimeColor }, `$${data.lifetime_usd.toFixed(4)}`),
      ),
      h(Box, { width: 10 }, h(Text, { dimColor: true }, 'lifetime')),
      h(Box, { flexGrow: 1 },
        h(Text, { dimColor: true }, `over ${history.length} runs`),
      ),
    ),
    h(Box, { marginTop: 1 },
      h(Text, { color: COLORS.brand, bold: true }, 'Top spending runs'),
    ),
    topRecent.length === 0
      ? h(Text, { dimColor: true, italic: true }, '  (no history entries recorded yet)')
      : h(Box, { flexDirection: 'column' },
          ...topRecent.map((r, i) => {
            const id = String(r.runId || '?').slice(0, 12);
            const isSession = sessionRunId && r.runId === sessionRunId;
            const code = (r.code === null || r.code === undefined) ? '—' : String(r.code);
            const usd = Number(r.usd) || 0;
            const usdColor = budgetColor(usd, budget);
            const codeColor =
              code === '0' ? COLORS.ok :
              code === '—' ? undefined : COLORS.error;
            return h(Box, { key: `r${i}` },
              h(Box, { width: 2 }, h(Text, null, ' ')),
              h(Box, { width: 14 },
                h(Text, { bold: isSession, color: isSession ? COLORS.brand : undefined, wrap: 'truncate-end' }, id),
              ),
              h(Box, { width: 6 }, h(Text, { color: codeColor }, code)),
              h(Box, { width: 12 },
                h(Text, { color: usdColor, bold: true }, `$${usd.toFixed(4)}`),
              ),
              h(Box, { flexGrow: 1 }, h(Text, { dimColor: true }, sinceStr(r.ts))),
            );
          }),
        ),
  );
}
