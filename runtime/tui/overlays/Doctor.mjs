/* ─────────────────────────────────────────────────────────────────────────
 * Doctor overlay — in-TUI health check (proxy / daemon / MCP / traces).
 * ─────────────────────────────────────────────────────────────────────────
 * Invokes the same `collectStatus()` the `golduck doctor` CLI uses, so the
 * user never has to leave the TUI to confirm everything is green.
 * Re-polls every 3s while open.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';
import { collectStatus } from '../../daemon/boot.mjs';

const h = React.createElement;

function glyphFor(ok) {
  if (ok === true)  return { g: GLYPH.check,   color: COLORS.ok };
  if (ok === false) return { g: GLYPH.cross,   color: COLORS.error };
  return               { g: GLYPH.diamond, color: undefined };
}

function Row({ label, ok, detail }) {
  const { g, color } = glyphFor(ok);
  return h(Box, null,
    h(Text, { color }, `${g} `),
    h(Text, { bold: true }, label.padEnd(18)),
    h(Text, { dimColor: true }, detail || ''),
  );
}

export function Doctor({ onClose, hasTTY }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const s = await collectStatus();
        if (!cancelled) setState({ loading: false, data: s });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e?.message || String(e) });
      }
    };
    run();
    const id = setInterval(run, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (state.loading) {
    return h(OverlayFrame, { title: `${GLYPH.diamond} doctor · loading` },
      h(Text, { dimColor: true }, 'loading…'),
    );
  }
  if (state.error) {
    return h(OverlayFrame, { title: `${GLYPH.diamond} doctor · error` },
      h(Text, { color: COLORS.error }, state.error),
    );
  }

  const s = state.data || {};
  const sv = s.services || {};
  const cxr = sv.cxr_proxy || {};
  const dx  = sv.droidx_proxy || {};
  const dm  = sv.daemon || {};
  const mcp = sv.mcp || {};
  const traces = (s.traces && s.traces.recent) || [];

  return h(OverlayFrame, { title: `${GLYPH.diamond} doctor`, footer: 'esc to close · refresh=3s' },
    h(Text, { color: COLORS.brand, bold: true }, 'Proxies'),
    h(Row, {
      label: 'cxr proxy', ok: cxr.healthz && cxr.readyz,
      detail: `port=${cxr.port}  pid=${cxr.pid || '—'}  healthz=${cxr.healthz ? 'ok' : 'down'}  readyz=${cxr.readyz ? 'ok' : 'down'}`,
    }),
    h(Row, {
      label: 'droidx proxy', ok: dx.healthz && dx.readyz,
      detail: `port=${dx.port}  pid=${dx.pid || '—'}  healthz=${dx.healthz ? 'ok' : 'down'}  readyz=${dx.readyz ? 'ok' : 'down'}`,
    }),
    h(Box, { marginTop: 1 }, h(Text, { color: COLORS.brand, bold: true }, 'Daemon')),
    h(Row, { label: 'golduck daemon', ok: dm.alive, detail: `pid=${dm.pid || '—'}` }),
    h(Box, { marginTop: 1 }, h(Text, { color: COLORS.brand, bold: true }, 'MCP')),
    ...Object.entries(mcp).map(([name, v]) =>
      h(Row, { key: name, label: name, ok: v === 'ok', detail: String(v) }),
    ),
    Object.keys(mcp).length === 0 && h(Text, { dimColor: true }, '  (no MCP entries reported)'),
    h(Box, { marginTop: 1 }, h(Text, { color: COLORS.brand, bold: true }, 'Traces')),
    h(Text, { dimColor: true }, `  home: ${s.home || '—'}`),
    h(Text, { dimColor: true }, `  recent: ${traces.slice(-5).join(', ') || '(none)'}`),
  );
}
