/* MCP server inspector — uses the cached probe when available. */
import React, { useEffect, useState } from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Box, Text, useInput } from 'ink';
import { OverlayFrame } from './OverlayFrame.mjs';
import { COLORS, GLYPH } from '../theme.mjs';
import { readCachedProbe } from '../mcp_probe.mjs';

const h = React.createElement;

const CONFIG_PATH = join(homedir(), '.codex', 'config.toml');

function parseArgs(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(inner))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function parseMcpServers(toml) {
  const out = {};
  const lines = toml.split('\n');
  let current = null;
  const header = /^\s*\[mcp_servers\.([^\]\s]+)\]\s*$/;
  const otherHeader = /^\s*\[[^\]]+\]\s*$/;
  const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
  for (const raw of lines) {
    const line = raw.replace(/^\s*#.*$/, '');
    const mh = line.match(header);
    if (mh) {
      current = mh[1];
      if (!out[current]) out[current] = { name: current, command: null, args: [] };
      continue;
    }
    if (otherHeader.test(line)) { current = null; continue; }
    if (!current) continue;
    const mk = line.match(kv);
    if (!mk) continue;
    const key = mk[1];
    const val = mk[2];
    if (key === 'command') {
      const m = val.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/);
      if (m) out[current].command = m[1] !== undefined ? m[1] : m[2];
    } else if (key === 'args' && val.trim().startsWith('[')) {
      out[current].args = parseArgs(val);
    }
  }
  return Object.values(out);
}

function parseEnvOverride(raw) {
  if (!raw) return [];
  return raw.split(',').map((pair) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return null;
    const name = pair.slice(0, idx).trim();
    const cmd = pair.slice(idx + 1).trim();
    if (!name || !cmd) return null;
    const parts = cmd.split(/\s+/);
    return { name, command: parts[0] || cmd, args: parts.slice(1) };
  }).filter(Boolean);
}

function loadServers() {
  const envServers = parseEnvOverride(process.env.GOLDUCK_MCP_SERVERS);
  let fileServers = [];
  if (existsSync(CONFIG_PATH)) {
    try { fileServers = parseMcpServers(readFileSync(CONFIG_PATH, 'utf8')); } catch { fileServers = []; }
  }
  const merged = new Map();
  for (const s of fileServers) merged.set(s.name, s);
  for (const s of envServers) merged.set(s.name, s);
  return Array.from(merged.values());
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s || ''; }

function Row({ server, probe }) {
  const hit = probe?.servers?.find((x) => x.name === server.name);
  const status = hit ? (hit.ok ? 'ok' : 'err') : 'unknown';
  const statusColor = status === 'ok' ? COLORS.ok : status === 'err' ? COLORS.error : undefined;
  const statusGlyph = status === 'ok' ? GLYPH.check : status === 'err' ? GLYPH.cross : GLYPH.diamond;
  const toolsText = hit ? (hit.ok ? `${hit.tool_count} tools` : 'probe failed') : '? tools';
  const cmdLine = [server.command || '(no command)', ...(server.args || [])].join(' ');

  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, null,
      h(Box, { width: 2 }, h(Text, { color: statusColor }, statusGlyph)),
      h(Box, { width: 18 }, h(Text, { color: COLORS.brand, bold: true }, server.name)),
      h(Box, { flexGrow: 1 }, h(Text, { dimColor: true }, toolsText)),
    ),
    h(Box, null,
      h(Box, { width: 2 }, h(Text, null, ' ')),
      h(Box, { flexGrow: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, truncate(cmdLine, 100))),
    ),
  );
}

export function Mcp({ onClose, hasTTY }) {
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [servers, setServers] = useState([]);
  const [probe, setProbe] = useState(null);
  useEffect(() => {
    setServers(loadServers());
    setProbe(readCachedProbe());
  }, []);

  useInput((ch, key) => {
    if (key.escape) onClose?.();
    else if (ch === 'r' || ch === 'R') { setReloadNonce((n) => n + 1); setProbe(readCachedProbe()); setServers(loadServers()); }
  }, { isActive: Boolean(hasTTY) });

  const healthy = (probe?.servers || []).filter((s) => s.ok).length;
  const total = servers.length;

  return h(OverlayFrame, {
    title: `${GLYPH.diamond} mcp`,
    footer: `${total} server${total === 1 ? '' : 's'}${probe ? ` · ${healthy} healthy · probe ${new Date(probe.ts).toLocaleTimeString()}` : ' · no probe yet'}  ·  esc to close`,
  },
    servers.length === 0
      ? h(Text, { dimColor: true }, '(no MCP servers configured in ~/.codex/config.toml)')
      : h(Box, { flexDirection: 'column' },
          ...servers.map((s, i) => h(Row, { key: i, server: s, probe })),
        ),
  );
}
