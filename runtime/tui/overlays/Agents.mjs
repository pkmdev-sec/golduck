/* ─────────────────────────────────────────────────────────────────────────
 * Agents overlay — visualize nested sub-agents spawned via spawn_agent /
 * rlm_*. Periodically rescans recent trace files for tool.call spans whose
 * name is `spawn_agent` or whose event name starts with `rlm.` / `spawn.agent.`
 * and lists them newest-first in fixed-width columns.
 * ───────────────────────────────────────────────────────────────────────── */
import React, { useEffect, useState } from 'react';
import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const MAX_FILES = 10;
const MAX_ROWS = 20;
const PREVIEW_MAX = 80;
const REFRESH_MS = 1000;

function isSpawnLike(ev) {
  if (!ev) return false;
  if (ev.span === 'tool.call' && ev.name === 'spawn_agent') return true;
  const n = ev.name || '';
  return n.startsWith('rlm.') || n.startsWith('spawn.agent.');
}

function extractPreview(ev) {
  const src = ev.prompt ?? ev.message ?? ev.input ?? ev.query ?? ev.problem ?? '';
  let s = '';
  if (typeof src === 'string') s = src;
  else if (src && typeof src === 'object') {
    try { s = JSON.stringify(src); } catch { s = String(src); }
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > PREVIEW_MAX) s = s.slice(0, PREVIEW_MAX - 1) + '…';
  return s;
}

function readEvents(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function listRecentTraceFiles() {
  const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  const TRACES = join(HOME, 'traces');
  if (!existsSync(TRACES)) return { files: [], dir: TRACES };
  let entries = [];
  try { entries = readdirSync(TRACES); } catch { entries = []; }
  const resolved = new Set();
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    let p = join(TRACES, f);
    if (f === 'current.jsonl') {
      try { p = realpathSync(p); } catch { /* keep as-is */ }
    }
    resolved.add(p);
  }
  const files = [...resolved].filter((p) => {
    try { return statSync(p).isFile(); } catch { return false; }
  }).sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  }).slice(0, MAX_FILES);
  return { files, dir: TRACES };
}

function collectAgents() {
  const { files } = listRecentTraceFiles();
  const sessions = [];
  let observed = 0;
  for (const file of files) {
    const evs = readEvents(file);
    // FIFO queue of pending tool.call entries (all tools, not just spawns);
    // span.exit events in these traces don't always carry the id, so we pop
    // by arrival order when no id match is available.
    const pending = [];
    const byId = new Map();
    for (const ev of evs) {
      if (ev.span === 'tool.call' && ev.name !== 'span.exit') {
        const entry = {
          id: ev.tool_use_id || ev.id || null,
          file,
          started: ev.ts || null,
          ended: null,
          duration_ms: null,
          ok: null,
          name: ev.name || '',
          role: ev.agent_type || ev.role || ev.name || 'agent',
          reasoning_effort: ev.reasoning_effort || null,
          model_override: ev.model || ev.model_override || null,
          preview: extractPreview(ev),
          isSpawn: isSpawnLike(ev),
          running: true,
        };
        pending.push(entry);
        if (entry.id) byId.set(entry.id, entry);
        if (entry.isSpawn) { sessions.push(entry); observed++; }
      } else if (ev.name === 'span.exit' && ev.span === 'tool.call') {
        let target = null;
        const exitId = ev.tool_use_id || ev.id || null;
        if (exitId && byId.has(exitId)) {
          target = byId.get(exitId);
          byId.delete(exitId);
          const idx = pending.indexOf(target);
          if (idx >= 0) pending.splice(idx, 1);
        } else if (pending.length) {
          target = pending.shift();
          if (target.id) byId.delete(target.id);
        }
        if (target) {
          target.ended = ev.ts || null;
          target.duration_ms = typeof ev.duration_ms === 'number' ? ev.duration_ms : null;
          target.ok = ev.ok === undefined ? null : Boolean(ev.ok);
          target.running = false;
        }
      } else if (isSpawnLike(ev)) {
        // Non-tool.call spawn.agent.*/rlm.* events (informational or
        // standalone). Treat as a completed session.
        const entry = {
          id: ev.tool_use_id || ev.id || null,
          file,
          started: ev.ts || null,
          ended: ev.ts || null,
          duration_ms: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
          ok: ev.ok === undefined ? true : Boolean(ev.ok),
          name: ev.name || '',
          role: ev.agent_type || ev.role || ev.name || 'agent',
          reasoning_effort: ev.reasoning_effort || null,
          model_override: ev.model || ev.model_override || null,
          preview: extractPreview(ev),
          isSpawn: true,
          running: false,
        };
        sessions.push(entry);
        observed++;
      }
    }
  }
  sessions.sort((a, b) => {
    const ta = a.started || '';
    const tb = b.started || '';
    return tb.localeCompare(ta);
  });
  return { sessions: sessions.slice(0, MAX_ROWS), observed, fileCount: files.length };
}

function statusGlyphAndColor(s) {
  if (s.running || s.ok === null) return { g: GLYPH.diamond, color: COLORS.dim };
  if (s.ok) return { g: GLYPH.check, color: COLORS.ok };
  return { g: GLYPH.cross, color: COLORS.error };
}

export function Agents({ onClose, hasTTY }) {
  const [data, setData] = useState(() => collectAgents());

  useEffect(() => {
    const reload = () => {
      try { setData(collectAgents()); } catch { /* swallow */ }
    };
    reload();
    const id = setInterval(reload, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  useInput((_ch, key) => {
    if (key.escape) onClose?.();
  }, { isActive: Boolean(hasTTY) });

  const { sessions, observed, fileCount } = data || { sessions: [], observed: 0, fileCount: 0 };
  const title = `${GLYPH.diamond} agents`;
  const badge = `· ${observed} runs observed across last ${fileCount} trace files`;
  const footer = `esc to close · refresh=${Math.round(REFRESH_MS / 1000)}s`;

  if (!sessions.length) {
    return h(OverlayFrame, { title, footer },
      h(Box, { flexDirection: 'column' },
        h(Text, { dimColor: true }, badge),
        h(Box, { marginTop: 1 },
          h(Text, { dimColor: true, italic: true },
            '(no sub-agent spawns seen yet — use spawn_agent / rlm_query to populate)'),
        ),
      ),
    );
  }

  return h(OverlayFrame, { title, footer },
    h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, badge),
      h(Box, { marginTop: 1, flexDirection: 'column' },
        ...sessions.map((s, i) => {
          const { g, color } = statusGlyphAndColor(s);
          const ts = (s.started || '').slice(11, 19) || '--:--:--';
          const idShort = (s.id || '-').slice(0, 8);
          const role = s.role || s.name || 'agent';
          return h(Box, { key: `a${i}` },
            h(Box, { width: 2 }, h(Text, { color }, g)),
            h(Box, { width: 8 }, h(Text, { dimColor: true }, ts)),
            h(Box, { width: 14 },
              h(Text, { bold: true, wrap: 'truncate-end' }, role),
            ),
            h(Box, { width: 10 },
              h(Text, { dimColor: true, wrap: 'truncate-end' }, idShort),
            ),
            h(Box, { flexGrow: 1 },
              h(Text, { dimColor: true, wrap: 'truncate-end' },
                s.preview || '(no prompt recorded)'),
            ),
          );
        }),
      ),
    ),
  );
}
