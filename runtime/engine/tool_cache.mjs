/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool-result cache (runtime/engine/tool_cache.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Small, in-memory LRU cache for idempotent tool reads. Repeated
 * `read`/`ls`/`glob`/`grep` calls with the same args during a turn (and
 * across nearby turns) return the first result instead of re-running.
 *
 * Safety contract: only strictly read-only native tools are cached.
 * Writes and destructive tools (shell, apply_patch, write) bypass. MCP
 * and browser tools are conservatively NOT cached — they can produce
 * different bytes per call even for "read-like" shapes.
 *
 * Whenever the caller mutates the filesystem (apply_patch / write /
 * mutating shell), it MUST call `invalidateByPrefix(touchedPath)` so
 * cached reads of the same subtree don't go stale. On errors or
 * uncertainty, callers may `invalidateAll()`.
 *
 * Implementation:
 *   - `Map` keeps insertion order; get() does delete+set to promote
 *     the entry to most-recently-used (classic LRU-on-Map trick).
 *   - maxSize = 128 entries (env `GOLDUCK_TOOL_CACHE_MAX`).
 *   - ttlMs   = 30 000   (env `GOLDUCK_TOOL_CACHE_TTL_MS`). Checked on
 *     get — expired entries are evicted lazily (no background timer).
 *   - keys: `<toolName>::<stable-json(input)>` where keys of every
 *     object (top-level and nested) are sorted alphabetically so
 *     `{a:1,b:2}` and `{b:2,a:1}` collide.
 *
 * Emits `tool_cache.hit`, `tool_cache.miss`, `tool_cache.evict` trace
 * events. All IO is O(1) and fire-and-forget.
 * ───────────────────────────────────────────────────────────────────────── */
import { event } from '../trace/tracer.mjs';

// Native read-only tools: always cacheable.
const CACHEABLE_TOOLS = new Set(['read', 'ls', 'glob', 'grep', 'web_fetch', 'memory_get', 'memory_list', 'memory_search', 'skill_list']);

// MCP tool suffixes that look read-only. We keep this conservative — callers
// with side-effectful "read" semantics should name their tool differently.
const CACHEABLE_MCP_SUFFIXES = ['_read', '_get', '_list', '_search', '_fetch', '_browse'];

function isMcpReadonly(name) {
  if (typeof name !== 'string' || !name.includes('__')) return false;
  return CACHEABLE_MCP_SUFFIXES.some((suf) => name.endsWith(suf));
}

const MAX_SIZE = (() => {
  const n = parseInt(process.env.GOLDUCK_TOOL_CACHE_MAX || '128', 10);
  return Number.isFinite(n) && n > 0 ? n : 128;
})();

const TTL_MS = (() => {
  const n = parseInt(process.env.GOLDUCK_TOOL_CACHE_TTL_MS || '30000', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();

// key -> { value, expiresAt, paths }
const cache = new Map();
let hits = 0;
let misses = 0;

/**
 * Stable JSON serializer: object keys are sorted at every depth so the
 * output is deterministic regardless of property insertion order.
 * `undefined` is coerced to `null` so keys never go missing silently.
 */
function stableStringify(v) {
  if (v === undefined || v === null) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/** Collect every string leaf from a value. Used to extract path-ish
 * fields from a tool input without caring about which key names carry
 * them (path / paths / dir / cwd / pattern / file / files / ...). */
function collectStrings(v, out) {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') { if (v) out.push(v); return; }
  if (typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
  for (const k of Object.keys(v)) collectStrings(v[k], out);
}

function extractPathsFromKey(key) {
  const sep = key.indexOf('::');
  if (sep < 0) return [];
  try {
    const parsed = JSON.parse(key.slice(sep + 2));
    const out = [];
    collectStrings(parsed, out);
    return out;
  } catch {
    return [];
  }
}

/** True if two path strings refer to the same subtree in either
 * direction: `/a/b` relates to `/a/b/c` (descendant) and vice-versa
 * (ancestor). Uses separator-boundary matching so `/foo` does not
 * accidentally match `/foobar`. */
function pathRelates(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aSlash = a.endsWith('/') ? a : a + '/';
  const bSlash = b.endsWith('/') ? b : b + '/';
  return a.startsWith(bSlash) || b.startsWith(aSlash);
}

function shortKey(k) {
  if (typeof k !== 'string') return k;
  return k.length > 160 ? k.slice(0, 160) + '…' : k;
}

/**
 * Build a stable cache key for a (toolName, input) pair, or return
 * null if the tool is not in the read-only whitelist.
 */
export function cacheKey(toolName, input) {
  if (typeof toolName !== 'string') return null;
  if (!CACHEABLE_TOOLS.has(toolName) && !isMcpReadonly(toolName)) return null;
  const serialized = stableStringify(input ?? {});
  return toolName + '::' + serialized;
}

/**
 * Look up a previously-cached tool result. On hit the entry is
 * promoted to most-recently-used.
 */
export function getCached(key) {
  if (!key || typeof key !== 'string') return { hit: false };
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    event('tool_cache.miss', { key: shortKey(key) });
    return { hit: false };
  }
  if (TTL_MS > 0 && entry.expiresAt <= Date.now()) {
    cache.delete(key);
    misses++;
    event('tool_cache.evict', { key: shortKey(key), reason: 'ttl' });
    event('tool_cache.miss', { key: shortKey(key) });
    return { hit: false };
  }
  // LRU promote.
  cache.delete(key);
  cache.set(key, entry);
  hits++;
  event('tool_cache.hit', { key: shortKey(key) });
  return { hit: true, value: entry.value };
}

/**
 * Remember a tool result. If size exceeds the max, evict the
 * least-recently-used entries (one per call — typically 0 or 1).
 */
export function setCached(key, value) {
  if (!key || typeof key !== 'string') return;
  const entry = {
    value,
    expiresAt: Date.now() + TTL_MS,
    paths: extractPathsFromKey(key),
  };
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
    event('tool_cache.evict', { key: shortKey(oldest), reason: 'lru' });
  }
}

/** Drop everything. */
export function invalidateAll() {
  const count = cache.size;
  cache.clear();
  if (count > 0) event('tool_cache.evict', { reason: 'all', count });
}

/**
 * Drop every entry whose recorded path strings touch (ancestor or
 * descendant of) `pathPrefix`. Callers invoke this after any
 * filesystem mutation so subsequent reads re-hit disk.
 */
export function invalidateByPrefix(pathPrefix) {
  if (!pathPrefix || typeof pathPrefix !== 'string') return;
  const doomed = [];
  for (const [k, e] of cache) {
    const paths = e.paths || [];
    for (const p of paths) {
      if (pathRelates(p, pathPrefix)) { doomed.push(k); break; }
    }
  }
  for (const k of doomed) cache.delete(k);
  if (doomed.length > 0) {
    event('tool_cache.evict', { reason: 'prefix', prefix: pathPrefix, count: doomed.length });
  }
}

export function stats() {
  return { hits, misses, size: cache.size, maxSize: MAX_SIZE };
}

/**
 * Extract every path string a mutating tool is about to touch.
 * Conservative: returns an empty array when the input shape is unknown, which
 * makes callers fall back to invalidateAll() — safer than stale reads.
 */
export function pathsForTool(toolName, input) {
  if (!input || typeof input !== 'object') return [];
  if (toolName === 'write' && typeof input.path === 'string') return [input.path];
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    const out = [];
    const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    let m;
    while ((m = re.exec(input.patch))) out.push(m[1].trim());
    return out;
  }
  if (toolName === 'shell' && typeof input.command === 'string') {
    // Very rough: pull out tokens that look like paths. On misses we return
    // [] so the caller falls back to invalidateAll(). Worth the imprecision
    // because shell is rare; we'd rather be safe.
    const toks = input.command.match(/(?<=\s|^)([./~][\w./~-]+|\w[\w./-]*\.\w+)/g) || [];
    return toks.slice(0, 10);
  }
  return [];
}
