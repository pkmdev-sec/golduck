/* ─────────────────────────────────────────────────────────────────────────
 * golduck embedding-backed recall (runtime/memory/recall_embed.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Optional vectorstore layer that coexists with the lexical (TF-IDF)
 * recall.mjs path. Fully opt-in via GOLDUCK_RECALL_BACKEND=embed.
 *
 * Design constraints:
 *   - No heavy ML deps. The embedding layer is pluggable via a user-provided
 *     function hook (global.__golduckEmbed or an env-var-named module path).
 *   - On-disk index lives at $GOLDUCK_HOME/memory/embed-index.jsonl,
 *     one record per line: {id, vec:[…], source, text, at}.
 *   - Fallback: when no embedder is configured or an embedding call
 *     throws, we transparently re-route to recall.mjs so the caller
 *     never sees a failure mode it doesn't already handle.
 * ───────────────────────────────────────────────────────────────────────── */

import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { recall as lexicalRecall } from './recall.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const INDEX = () => join(HOME(), 'memory', 'embed-index.jsonl');

/** Returns the user-provided embedder function, or null.
 *  Precedence:
 *    1. globalThis.__golduckEmbed (set by a loaded plugin module)
 *    2. process.env.GOLDUCK_EMBED_MODULE — dynamic import + .embed() export
 *    3. null (caller falls back to lexical recall) */
async function loadEmbedder() {
  if (typeof globalThis.__golduckEmbed === 'function') return globalThis.__golduckEmbed;
  const modPath = process.env.GOLDUCK_EMBED_MODULE;
  if (modPath && typeof modPath === 'string') {
    try {
      const mod = await import(modPath);
      if (typeof mod.embed === 'function') return mod.embed;
    } catch { /* fall through to null */ }
  }
  return null;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function loadIndex() {
  const f = INDEX();
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Embed + append a single memory record so it's searchable via
 * embedRecall() later.  Fire-and-forget; never throws.
 */
export async function indexEmbed({ id, text, source = 'journal' }) {
  if (!text || typeof text !== 'string') return { ok: false, error: 'empty_text' };
  const embed = await loadEmbedder();
  if (!embed) return { ok: false, error: 'no_embedder' };
  try {
    const vec = await embed(text);
    if (!Array.isArray(vec) || !vec.length) return { ok: false, error: 'bad_embedding' };
    const f = INDEX();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify({
      id: id || `emb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      vec, source, text: String(text).slice(0, 2000), at: new Date().toISOString(),
    }) + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/**
 * Embedding-based recall. Returns the top-K matches by cosine similarity.
 * Transparent fallback to lexical recall if no embedder is configured,
 * the index is empty, or the embedder throws.
 */
export async function embedRecall({ query, k = 3, threshold = 0.2 } = {}) {
  if (process.env.GOLDUCK_RECALL_BACKEND !== 'embed') {
    return lexicalRecall({ query, k });
  }
  const embed = await loadEmbedder();
  if (!embed) return lexicalRecall({ query, k });
  const idx = loadIndex();
  if (!idx.length) return lexicalRecall({ query, k });
  let qvec;
  try {
    qvec = await embed(query);
    if (!Array.isArray(qvec)) throw new Error('embedder returned non-array');
  } catch {
    return lexicalRecall({ query, k });
  }
  const scored = idx.map((row) => ({ ...row, score: cosine(qvec, row.vec || []) }))
    .filter((r) => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (!scored.length) return lexicalRecall({ query, k });
  return scored.map((r) => ({
    kind: r.source || 'embed',
    text: String(r.text || '').slice(0, 500),
    score: Math.round(r.score * 100) / 100,
    at: r.at || null,
  }));
}

/** Expose the active backend for observability / tests. */
export function currentRecallBackend() {
  return process.env.GOLDUCK_RECALL_BACKEND === 'embed' ? 'embed' : 'lexical';
}
