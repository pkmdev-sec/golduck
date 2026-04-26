/* ─────────────────────────────────────────────────────────────────────────
 * golduck autonomous lessons writer (runtime/memory/lessons.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Sibling to recall.mjs's TF-IDF store. This module is the WRITER for
 * post-turn auto-verify lessons: whenever auto_verify returns a
 * { verdict: 'revise', issues, suggested_fix } verdict, we append a
 * line to `$GOLDUCK_HOME/memory/lessons.jsonl` so future turns can
 * recall the failure and its fix.
 *
 * Fire-and-forget. Must never throw. Graceful on missing files/dirs.
 * ───────────────────────────────────────────────────────────────────────── */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const LESSONS_PATH = () => join(HOME(), 'memory', 'lessons.jsonl');

/**
 * Append one JSON line to lessons.jsonl with an ISO timestamp.
 * Fire-and-forget — never throws. Creates the dir if missing.
 * Skips write if entry.question is empty or both issues and suggested_fix are missing.
 */
export function appendLesson(entry) {
  try {
    const e = entry || {};
    const question = typeof e.question === 'string' ? e.question.trim() : '';
    if (!question) return;
    const hasIssues = Array.isArray(e.issues) && e.issues.length > 0;
    const hasFix = typeof e.suggested_fix === 'string' && e.suggested_fix.trim().length > 0;
    if (!hasIssues && !hasFix) return;

    const path = LESSONS_PATH();
    try { mkdirSync(join(HOME(), 'memory'), { recursive: true }); } catch { /* ignore */ }

    const record = {
      at: new Date().toISOString(),
      question,
      issues: hasIssues ? e.issues : [],
      suggested_fix: hasFix ? e.suggested_fix : null,
      verdict: typeof e.verdict === 'string' ? e.verdict : null,
      tags: Array.isArray(e.tags) ? e.tags : [],
    };
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  } catch {
    /* fire-and-forget: never throw */
  }
}

/**
 * Read lessons.jsonl, return the last N parsed entries (newest last).
 * Malformed lines are skipped. Returns [] on missing file or any error.
 */
export function loadLessons(limit = 50) {
  try {
    const path = LESSONS_PATH();
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
    }
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    return out.slice(-n);
  } catch {
    return [];
  }
}

/**
 * If the verdict warrants it (verdict === 'revise' OR non-empty issues),
 * append a lesson and return true. Otherwise return false.
 */
export function maybeAutoLesson({ question, finalText, verdict } = {}) {
  try {
    if (!verdict || typeof verdict !== 'object') return false;
    const shouldRecord =
      verdict.verdict === 'revise' ||
      (Array.isArray(verdict.issues) && verdict.issues.length > 0);
    if (!shouldRecord) return false;
    appendLesson({
      question,
      issues: Array.isArray(verdict.issues) ? verdict.issues : [],
      suggested_fix: typeof verdict.suggested_fix === 'string' ? verdict.suggested_fix : null,
      verdict: typeof verdict.verdict === 'string' ? verdict.verdict : null,
    });
    return true;
  } catch {
    return false;
  }
}
