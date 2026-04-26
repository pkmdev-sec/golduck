/* ─────────────────────────────────────────────────────────────────────────
 * golduck memory recall (runtime/memory/recall.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Given the current user prompt, search the journal + pins + lessons for
 * the top-N most lexically-relevant past entries. Pure TF-IDF-lite + cosine,
 * zero deps. Used to enrich the system bundle with "what we learned last
 * time you asked something similar".
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');

function tokens(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3);
}

function tf(toks) {
  const m = new Map();
  for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function idf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const idfMap = new Map();
  for (const [t, c] of df) idfMap.set(t, Math.log((N + 1) / (c + 1)) + 1);
  return idfMap;
}

function tfidfVec(toks, idfMap) {
  const tfMap = tf(toks);
  const v = new Map();
  for (const [t, c] of tfMap) v.set(t, c * (idfMap.get(t) || 1));
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, v] of a) { na += v * v; const w = b.get(t); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function loadJsonl(path) {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Recall top-K past memory snippets relevant to the query.
 *  Returns an array of { kind, text, score, at }. */
export function recall({ query, k = 3 } = {}) {
  const journal = loadJsonl(join(HOME(), 'memory', 'journal.jsonl'));
  const lessons = loadJsonl(join(HOME(), 'memory', 'lessons.jsonl'));
  const facts   = loadJsonl(join(HOME(), 'memory', 'facts.jsonl'));

  const corpus = [
    ...journal.map((j) => ({ kind: 'journal', text: j.entry || JSON.stringify(j), at: j.ts, src: j })),
    ...lessons.map((l) => ({ kind: 'lesson',  text: [l.question, (l.issues||[]).join('; '), l.suggested_fix].filter(Boolean).join(' | '), at: l.ts, src: l })),
    ...facts.map((f)   => ({ kind: 'fact',    text: f.fact || '', at: f.ts, src: f })),
  ];
  if (!corpus.length) return [];

  for (const d of corpus) d.toks = tokens(d.text);
  const qToks = tokens(query);
  if (!qToks.length) return [];

  const idfMap = idf([{ toks: qToks }, ...corpus]);
  const qVec = tfidfVec(qToks, idfMap);
  const scored = corpus.map((d) => ({ ...d, score: cosine(qVec, tfidfVec(d.toks, idfMap)) }));
  const threshold = parseFloat(process.env.GOLDUCK_RECALL_THRESHOLD || '0.05');
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((d) => d.score > threshold).slice(0, k).map((d) => ({
    kind: d.kind, text: d.text.slice(0, 500), score: Math.round(d.score * 100) / 100, at: d.at,
  }));
}
