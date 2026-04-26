/* ─────────────────────────────────────────────────────────────────────────
 * golduck lenient JSON parsing (runtime/engine/json_parse.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Shared helpers for parsing JSON emitted by LLMs: strips ```json fences,
 * trims whitespace, best-effort extracts a {...} / [...] block from
 * surrounding prose, and coerces a structured verdict into a known shape.
 *
 * Zero-dep, never-throws. Consolidates logic previously duplicated across
 * engine/safety.mjs, engine/panel_verify.mjs, engine/planner.mjs,
 * memory/fact_extract.mjs, and tools/rlm.mjs.
 * ───────────────────────────────────────────────────────────────────────── */

const FENCE_RE = /^```(?:json)?\s*|\s*```$/g;

export function safeJsonParse(raw, { fallback = null } = {}) {
  const cleaned = String(raw ?? '').trim().replace(FENCE_RE, '').trim();
  if (!cleaned) return fallback;
  try { return JSON.parse(cleaned); } catch { return fallback; }
}

export function extractJsonBlock(raw) {
  const s = String(raw ?? '');
  const cleaned = s.trim().replace(FENCE_RE, '').trim();
  if (cleaned) {
    try { return JSON.parse(cleaned); } catch { /* try block extraction */ }
  }
  const objIdx = s.indexOf('{');
  const arrIdx = s.indexOf('[');
  const candidates = [];
  if (objIdx >= 0) candidates.push([objIdx, '{', '}']);
  if (arrIdx >= 0) candidates.push([arrIdx, '[', ']']);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, open, close] of candidates) {
    const block = findBalanced(s, start, open, close);
    if (block) {
      try { return JSON.parse(block); } catch { /* try next candidate */ }
    }
  }
  return null;
}

function findBalanced(s, start, open, close) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseVerdict(raw) {
  const parsed = extractJsonBlock(raw);
  const p = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const verdict = p.verdict === 'approve' || p.verdict === 'revise' ? p.verdict : 'unknown';
  let confidence = Number(p.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  const issues = Array.isArray(p.issues)
    ? p.issues.map((x) => String(x).slice(0, 300)).slice(0, 10)
    : [];
  // suggested_fix: permissive in — normalize array/object/string to string.
  let suggested_fix = null;
  if (typeof p.suggested_fix === 'string' && p.suggested_fix.trim()) {
    suggested_fix = p.suggested_fix;
  } else if (Array.isArray(p.suggested_fix) && p.suggested_fix.length) {
    suggested_fix = p.suggested_fix.map(String).join('\n').trim() || null;
  } else if (p.suggested_fix && typeof p.suggested_fix === 'object' && !Array.isArray(p.suggested_fix)) {
    const j = JSON.stringify(p.suggested_fix);
    suggested_fix = j !== '{}' ? j : null;
  }
  return { verdict, confidence, issues, suggested_fix };
}
