/* ─────────────────────────────────────────────────────────────────────────
 * golduck prompt pre-flight (runtime/tui/preflight.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Analyze a user prompt BEFORE dispatch. Mirrors the router's scoring
 * heuristic in spirit (length + keyword signals) but scoped to surfacing
 * UX-level advice: complexity bucket, thinking budget, verify recommendation,
 * and safety warnings for destructive verbs.
 *
 * Pure, zero-dep, no React. Safe to call from any surface.
 * ───────────────────────────────────────────────────────────────────────── */

const CROSS_CUTTING = [
  'refactor', 'rename', 'migrate', 'rewire', 'architect', 'audit',
  'every', 'all files', 'entire', 'full', 'cross', 'end to end',
];
const AMBIGUOUS = ['maybe', 'probably', 'somehow', 'figure out', 'try'];
const DESTRUCTIVE = ['delete', 'drop', 'truncate', 'rm -rf', 'force push'];
const VERIFY_HINTS = ['test', 'verify', 'unit', 'spec'];

function countHits(haystack, needles) {
  let hits = 0;
  for (const n of needles) {
    if (haystack.includes(n)) hits += 1;
  }
  return hits;
}

/** Analyze a prompt and return a pre-flight verdict. */
export function analyzePrompt(prompt) {
  const raw = String(prompt || '');
  const s = raw.toLowerCase();
  const signals = [];
  const warnings = [];
  let score = 0;

  // length
  const len = raw.length;
  if (len < 80) score += 0;
  else if (len < 300) score += 10;
  else if (len < 1500) score += 25;
  else score += 40;

  // code fences
  if (raw.includes('```')) {
    score += 10;
    signals.push('contains code fence');
  }

  // cross-cutting
  const crossHits = countHits(s, CROSS_CUTTING);
  if (crossHits > 0) {
    score += Math.min(crossHits * 20, 40);
    signals.push('cross-cutting scope');
  }

  // ambiguity
  const ambigHits = countHits(s, AMBIGUOUS);
  if (ambigHits > 0) {
    score += Math.min(ambigHits * 5, 10);
    signals.push('ambiguous wording');
  }

  // destructive
  const destructiveHits = countHits(s, DESTRUCTIVE);
  if (destructiveHits > 0) {
    score += 15;
    warnings.push('destructive verb detected — expect a safety gate');
  }

  // verify
  const verifyHits = countHits(s, VERIFY_HINTS);
  if (verifyHits > 0) {
    score += 5;
    signals.push('verification requested');
  }

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let complexity;
  let suggestedThinking;
  let suggestedVerify;
  if (score <= 10) {
    complexity = 'trivial';
    suggestedThinking = { budget_tokens: 4000, level: 'low' };
    suggestedVerify = 'off';
  } else if (score <= 30) {
    complexity = 'small';
    suggestedThinking = { budget_tokens: 8000, level: 'medium' };
    suggestedVerify = 'auto';
  } else if (score <= 60) {
    complexity = 'medium';
    suggestedThinking = { budget_tokens: 16000, level: 'medium' };
    suggestedVerify = 'auto';
  } else if (score <= 85) {
    complexity = 'large';
    suggestedThinking = { budget_tokens: 32000, level: 'high' };
    suggestedVerify = 'on';
  } else {
    complexity = 'epic';
    suggestedThinking = { budget_tokens: 64000, level: 'xhigh' };
    suggestedVerify = 'on';
  }

  return {
    complexity,
    score,
    signals,
    suggestedThinking,
    suggestedVerify,
    warnings,
  };
}

function fmtBudget(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/** Single-line summary for toast/status output. */
export function summarizeForToast(pf) {
  if (!pf || typeof pf !== 'object') return 'preflight: (unknown)';
  const budget = fmtBudget(pf.suggestedThinking?.budget_tokens ?? 0);
  const verify = pf.suggestedVerify || 'auto';
  const tail = (pf.signals && pf.signals.length)
    ? `  — ${pf.signals.join(', ')}`
    : '';
  return `preflight: ${pf.complexity} (${pf.score})  think=${budget}  verify=${verify}${tail}`;
}
