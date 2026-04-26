/* ─────────────────────────────────────────────────────────────────────────
 * golduck mid-run memory refresh (runtime/memory/refresh.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * The system bundle is built once at run start and frozen with
 * cache_control: ephemeral so Anthropic caches it. That's fast, but it
 * means any memory written DURING the session (new lessons, freshly
 * extracted facts, mid-run pins) never reach the model.
 *
 * This module produces a SMALL, per-turn refresh block containing:
 *   - up to 3 recall hits against the current user message
 *   - the most recent 1 lesson (if any) written since last refresh
 *   - the most recent 2 facts written since last refresh
 * …rendered as a compact "## Memory refresh" markdown block the engine
 * can prepend for JUST the current turn (caller controls lifecycle).
 *
 * Keeping it to ≤ 1500 chars keeps the prompt cheap and avoids ballooning
 * the effective system bundle.
 * ───────────────────────────────────────────────────────────────────────── */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { recall } from './recall.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');

function tailN(path, n) {
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function mtime(path) {
  try { return existsSync(path) ? statSync(path).mtimeMs : 0; } catch { return 0; }
}

/**
 * Build a compact refresh block. Returns null when there's nothing new.
 * `sinceMs` — only surface entries newer than this timestamp (ms epoch).
 */
export function buildRefresh({ userText, sinceMs = 0, maxChars = 1500 } = {}) {
  const hits = (() => {
    try { return recall({ query: userText, k: 3 }) || []; } catch { return []; }
  })();

  const factsPath = join(HOME(), 'memory', 'facts.jsonl');
  const lessonsPath = join(HOME(), 'memory', 'lessons.jsonl');

  const recentFacts = tailN(factsPath, 8).filter((f) => {
    if (!sinceMs) return true;
    const t = Date.parse(f.ts || '');
    return Number.isFinite(t) && t > sinceMs;
  }).slice(-2);
  const recentLessons = tailN(lessonsPath, 5).filter((l) => {
    if (!sinceMs) return true;
    const t = Date.parse(l.at || l.ts || '');
    return Number.isFinite(t) && t > sinceMs;
  }).slice(-1);

  if (!hits.length && !recentFacts.length && !recentLessons.length) return null;

  const lines = ['## Memory refresh'];
  if (hits.length) {
    lines.push('Recalled (by relevance):');
    for (const h of hits) {
      lines.push(`  - [${h.kind}] ${String(h.text).slice(0, 180)}`);
    }
  }
  if (recentFacts.length) {
    lines.push('Facts learned this session:');
    for (const f of recentFacts) lines.push(`  - ${String(f.fact || '').slice(0, 180)}`);
  }
  if (recentLessons.length) {
    lines.push('Recent lessons:');
    for (const l of recentLessons) {
      const summary = [l.question, (l.issues || []).slice(0, 2).join('; '), l.suggested_fix]
        .filter(Boolean).join(' | ');
      lines.push(`  - ${summary.slice(0, 180)}`);
    }
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars - 12) + '\n  … [trimmed]';
  return out;
}

/** Helper: mtime of memory sources (for "since last refresh" tracking). */
export function memoryMtimes() {
  const base = join(HOME(), 'memory');
  return {
    facts: mtime(join(base, 'facts.jsonl')),
    lessons: mtime(join(base, 'lessons.jsonl')),
    journal: mtime(join(base, 'journal.jsonl')),
  };
}
