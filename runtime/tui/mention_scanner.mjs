/* ─────────────────────────────────────────────────────────────────────────
 * mention_scanner — pure helpers for the multi-kind @-mention picker.
 * ─────────────────────────────────────────────────────────────────────────
 * No React. Exports:
 *   - parseMention(input)    → { kind, query, atIndex } | null
 *   - scanMentions(opts)     → Array<{ label, path, subtitle?, kind }>
 *
 * Supported kinds: 'file' (bare @token) · 'tool:' · 'pin:' · 'skill:'.
 * Sources:
 *   file  → ../tui/file_scanner.mjs (scanFilesSync)
 *   tool  → ~/.golduck/tmp/tools-catalog.json  [{name, description?}, ...]
 *   pin   → ~/.golduck/memory/pins.json        [{key, value}, ...]
 *   skill → ~/.golduck/skills/*.json           filenames (+ description?)
 * ───────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanFilesSync } from './file_scanner.mjs';

const KIND_PREFIXES = ['tool', 'pin', 'skill'];

/**
 * Parse a composer buffer to find the active @-mention at the tail.
 * Returns null if there's no @ or if whitespace breaks the token.
 */
export function parseMention(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  const atIndex = input.lastIndexOf('@');
  if (atIndex < 0) return null;

  const after = input.slice(atIndex + 1);
  if (/\s/.test(after)) return null;

  // Try each typed prefix first (case-insensitive).
  const colonIdx = after.indexOf(':');
  if (colonIdx >= 0) {
    const head = after.slice(0, colonIdx).toLowerCase();
    if (KIND_PREFIXES.includes(head)) {
      const query = after.slice(colonIdx + 1);
      return { kind: head, query, atIndex };
    }
  }

  // Bare token → file.
  return { kind: 'file', query: after, atIndex };
}

/* ── tiny fuzzy score ──────────────────────────────────────────────────── */
function subwords(s) {
  return String(s).toLowerCase().split(/[-_./\s]+/).filter(Boolean);
}

function fuzzyScore(haystack, query) {
  if (!query) return 1; // keep everything when query is empty
  const q = query.toLowerCase();
  const h = String(haystack || '').toLowerCase();
  let s = 0;
  if (h.startsWith(q)) s += 100;
  if (h.includes(q))   s += 40;
  const words = subwords(h);
  let qi = 0;
  for (const w of words) {
    if (qi < q.length && w.startsWith(q[qi])) {
      s += 5;
      qi += 1;
    }
  }
  return s;
}

function readJsonSafe(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function homeGolduck(...parts) {
  return path.join(os.homedir(), '.golduck', ...parts);
}

function rankAndSlice(rows, query, limit) {
  const scored = rows
    .map((r) => ({ ...r, _score: fuzzyScore(r._hay, query) }))
    .filter((r) => (query ? r._score > 0 : true));
  scored.sort((a, b) => (b._score - a._score) || String(a.label).length - String(b.label).length);
  return scored.slice(0, limit).map(({ _score, _hay, ...rest }) => rest);
}

function scanFilesKind(query, cwd, limit) {
  const hits = scanFilesSync({ cwd, query: query || '', limit });
  return hits.map((h) => ({
    kind: 'file',
    label: h.path,
    path: h.path,
    subtitle: h.kind === 'dir' ? 'dir' : undefined,
  }));
}

function scanToolsKind(query, limit) {
  const catalog = readJsonSafe(homeGolduck('tmp', 'tools-catalog.json'));
  if (!Array.isArray(catalog)) return [];
  const rows = catalog
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      kind: 'tool',
      label: t.name,
      path: t.name,
      subtitle: typeof t.description === 'string' ? t.description.slice(0, 80) : undefined,
      _hay: `${t.name} ${t.description || ''}`,
    }));
  return rankAndSlice(rows, query, limit);
}

function scanPinsKind(query, limit) {
  const pins = readJsonSafe(homeGolduck('memory', 'pins.json'));
  if (!Array.isArray(pins)) return [];
  const rows = pins
    .filter((p) => p && typeof p.key === 'string')
    .map((p) => ({
      kind: 'pin',
      label: p.key,
      path: `pin:${p.key}`,
      subtitle: typeof p.value === 'string' ? p.value.slice(0, 80) : undefined,
      _hay: p.key,
    }));
  return rankAndSlice(rows, query, limit);
}

function scanSkillsKind(query, limit) {
  const dir = homeGolduck('skills');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const rows = files.map((f) => {
    const name = f.replace(/\.json$/, '');
    const meta = readJsonSafe(path.join(dir, f));
    const description = meta && typeof meta.description === 'string' ? meta.description : undefined;
    return {
      kind: 'skill',
      label: name,
      path: `skill:${name}`,
      subtitle: description ? description.slice(0, 80) : undefined,
      _hay: `${name} ${description || ''}`,
    };
  });
  return rankAndSlice(rows, query, limit);
}

/**
 * Dispatch by kind. Always synchronous.
 */
export function scanMentions({ kind, query, cwd = process.cwd(), limit = 25 } = {}) {
  switch (kind) {
    case 'file':  return scanFilesKind(query, cwd, limit);
    case 'tool':  return scanToolsKind(query, limit);
    case 'pin':   return scanPinsKind(query, limit);
    case 'skill': return scanSkillsKind(query, limit);
    default:      return [];
  }
}
