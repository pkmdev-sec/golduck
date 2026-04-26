/* ─────────────────────────────────────────────────────────────────────────
 * file_scanner — cheap BFS file indexer for the @-mention overlay.
 * ─────────────────────────────────────────────────────────────────────────
 * Pure Node built-ins (fs + path). Two entry points:
 *   - scanFiles(...)     → Promise<Array<Record>>
 *   - scanFilesSync(...) → Array<Record>  (used by ink render)
 *
 * Record shape: { path: string, score: number, kind: 'file'|'dir', size?: number }
 *
 * Scoring is intentionally tiny (no fzf/levenshtein deps) so it stays snappy
 * even on warm repos with a few thousand files.
 *
 * Walk results are cached per `cwd` with a short TTL. The overlay re-invokes
 * the scanner on every keystroke, but only the rank/sort runs per call —
 * the directory walk reuses the cached entry list.
 * ───────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES   = 5000;
const MAX_TIME_MS   = 3000;
const CACHE_TTL_MS  = 2000;
const IGNORE_EXACT  = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build',
  '.next', '.venv', '__pycache__', '.pi', '.pi-cache', '.golduck',
]);
// Nested paths ignored by relative prefix match.
const IGNORE_PREFIX = ['codex-rs/target'];
// Hidden dirs we *do* want to walk.
const HIDDEN_ALLOW  = new Set(['.github', '.vscode']);

function shouldSkipDir(name, relPath) {
  if (IGNORE_EXACT.has(name)) return true;
  if (name.startsWith('.') && !HIDDEN_ALLOW.has(name)) return true;
  for (const p of IGNORE_PREFIX) {
    if (relPath === p || relPath.startsWith(`${p}/`)) return true;
  }
  return false;
}

function shouldSkipRel(relPath) {
  for (const p of IGNORE_PREFIX) {
    if (relPath === p || relPath.startsWith(`${p}/`)) return true;
  }
  return false;
}

/* Split a path into lowercase subwords for fuzzy first-letter scoring. */
function subwords(s) {
  return s.toLowerCase().split(/[-_./]+/).filter(Boolean);
}

function score(rec, query) {
  if (!query) return 0;
  const q      = query.toLowerCase();
  const pathLC = rec.path.toLowerCase();
  const base   = path.basename(rec.path);
  const baseLC = base.toLowerCase();
  let s = 0;

  if (baseLC.endsWith(q)) s += 100;
  if (baseLC.includes(q)) s += 40;
  if (pathLC.includes(q)) s += 15;

  // First-letter subword match — approximate fuzzy.
  const words = subwords(rec.path);
  let qi = 0;
  for (const w of words) {
    if (qi < q.length && w.startsWith(q[qi])) {
      s += 5;
      qi += 1;
    }
  }
  return s;
}

function rank(records, query, limit) {
  // Don't mutate the cached walk result — score into fresh copies.
  const scored = records.map((r) => ({ ...r, score: score(r, query) }));
  if (!query) {
    scored.sort((a, b) => a.path.length - b.path.length);
  } else {
    scored.sort((a, b) => (b.score - a.score) || (a.path.length - b.path.length));
  }
  return scored.slice(0, limit);
}

/* Shared gate used by both sync and async walkers. */
function makeGate() {
  const start = Date.now();
  let count = 0;
  return {
    hit() {
      count += 1;
      return count >= MAX_ENTRIES || (Date.now() - start) >= MAX_TIME_MS;
    },
  };
}

async function walkAsync(cwd) {
  const out   = [];
  const gate  = makeGate();
  const queue = [''];
  while (queue.length) {
    const rel = queue.shift();
    const abs = rel ? path.join(cwd, rel) : cwd;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, childRel)) continue;
        out.push({ path: childRel, kind: 'dir', score: 0 });
        queue.push(childRel);
      } else if (ent.isFile()) {
        if (shouldSkipRel(childRel)) continue;
        out.push({ path: childRel, kind: 'file', score: 0 });
      }
      if (gate.hit()) return out;
    }
  }
  return out;
}

function walkSync(cwd) {
  const out   = [];
  const gate  = makeGate();
  const queue = [''];
  while (queue.length) {
    const rel = queue.shift();
    const abs = rel ? path.join(cwd, rel) : cwd;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { continue; }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (shouldSkipDir(ent.name, childRel)) continue;
        out.push({ path: childRel, kind: 'dir', score: 0 });
        queue.push(childRel);
      } else if (ent.isFile()) {
        if (shouldSkipRel(childRel)) continue;
        out.push({ path: childRel, kind: 'file', score: 0 });
      }
      if (gate.hit()) return out;
    }
  }
  return out;
}

/* ── TTL cache ─────────────────────────────────────────────────────────── */
const walkCache = new Map(); // cwd → { at: number, data: Record[] }

function cachedGet(cwd) {
  const hit = walkCache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  return null;
}

function cachedPut(cwd, data) {
  walkCache.set(cwd, { at: Date.now(), data });
  return data;
}

/** Drop the walk cache (useful from tests or after writes touch the tree). */
export function clearFileScannerCache() {
  walkCache.clear();
}

export async function scanFiles({ cwd = process.cwd(), query = '', limit = 50 } = {}) {
  let all = cachedGet(cwd);
  if (!all) all = cachedPut(cwd, await walkAsync(cwd));
  return rank(all, query, limit);
}

export function scanFilesSync({ cwd = process.cwd(), query = '', limit = 50 } = {}) {
  let all = cachedGet(cwd);
  if (!all) all = cachedPut(cwd, walkSync(cwd));
  return rank(all, query, limit);
}
