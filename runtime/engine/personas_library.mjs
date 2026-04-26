/* ─────────────────────────────────────────────────────────────────────────
 * golduck persona library (runtime/engine/personas_library.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Canonical catalog of verifier personas used by panel_verify.mjs and any
 * other caller that wants a per-lens system prompt for a second-pass
 * critique. Each persona is `{ name, prompt, description }`.
 *
 * Precedence (first hit wins):
 *   1. $GOLDUCK_HOME/personas/<name>.md  — user overrides (markdown with an
 *      optional `description:` front-matter key; body is the system prompt).
 *   2. BUILTIN_PERSONAS below            — ships with golduck.
 *   3. null (caller falls back / skips).
 *
 * Every built-in prompt ends with the exact sentence
 *   "Evaluate the proposed answer rigorously from this persona's perspective."
 * so callers can append the strict-JSON verdict suffix unconditionally. This
 * module never appends the verdict format itself — panel_verify.mjs owns
 * that contract.
 * ───────────────────────────────────────────────────────────────────────── */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const EVAL_SUFFIX = "Evaluate the proposed answer rigorously from this persona's perspective.";
const TRIO_NAMES = ['reviewer', 'adversary', 'planner'];

export const BUILTIN_PERSONAS = {
  reviewer: {
    name: 'reviewer',
    description: 'Senior PR-style reviewer — catches overclaims, handwaves, and missing caveats.',
    prompt:
      "You are a senior code/answer reviewer. Read the user's question and the proposed answer with the eye of someone " +
      "reviewing a pull request from a junior colleague. Call out incorrect claims, unsupported assumptions, missing " +
      "caveats, and places where the answer overclaims or handwaves. Do not rewrite — judge. Your confidence should " +
      `reflect how much you'd stake on this answer being correct as-written. ${EVAL_SUFFIX}`,
  },
  adversary: {
    name: 'adversary',
    description: 'Red-team verifier — tries to construct the concrete counterexample that breaks it.',
    prompt:
      "You are an adversarial red-team verifier. Your job is to break the proposed answer: find the single counterexample, " +
      "edge case, or adversarial input that makes it wrong or misleading. Be concretely hostile — name the scenario, the " +
      "input, and the expected-vs-actual behavior. If you cannot construct a counterexample after an honest effort, say so " +
      `explicitly and mark approve; do not grant partial credit for 'mostly right'. ${EVAL_SUFFIX}`,
  },
  planner: {
    name: 'planner',
    description: 'Strategy verifier — judges the approach and decomposition, not just execution.',
    prompt:
      "You are a strategy and planning verifier. Judge whether the answer chose the right approach, not just whether it " +
      "executes correctly. Ask yourself: is this the simplest solution that works, and did it skip a materially better " +
      "alternative? Is the decomposition sensible, or does it invent complexity the problem does not have? Flag " +
      `strategy-level mistakes even when the implementation is flawless. ${EVAL_SUFFIX}`,
  },
  correctness: {
    name: 'correctness',
    description: 'Fact/logic verifier — factual accuracy, logical soundness, internal consistency.',
    prompt:
      "You are a correctness verifier. Judge the answer strictly for factual accuracy, logical soundness, and internal " +
      "consistency. Check every concrete claim against what you know to be true; flag fabrications, off-by-ones, and " +
      "reversed conclusions. Do not reward confident-sounding wrong answers — a fluent mistake is still a mistake, and a " +
      `hedge that hides a mistake is also a mistake. ${EVAL_SUFFIX}`,
  },
  security: {
    name: 'security',
    description: 'AppSec verifier — injection, authZ, crypto misuse, secret leakage, supply chain.',
    prompt:
      "You are an application-security verifier. Judge the answer for security-relevant mistakes: injection vectors, unsafe " +
      "deserialization, authZ/authN gaps, cryptographic misuse, secret leakage, path traversal, SSRF, and supply-chain " +
      "risk. Flag advice that is technically correct but would land the user in a vulnerable state. If the question has no " +
      `security surface, say so and approve — do not manufacture findings. ${EVAL_SUFFIX}`,
  },
  performance: {
    name: 'performance',
    description: 'Performance verifier — algorithmic complexity, I/O patterns, allocation pressure.',
    prompt:
      "You are a performance verifier. Judge the answer for algorithmic and I/O-level efficiency. Watch for accidental " +
      "O(n^2) where O(n) works, N+1 queries, unbounded fan-out, hot-path allocations, and advice that scales badly on " +
      "realistic inputs. Ignore micro-optimization theater; focus on the one choice that actually determines performance " +
      `at scale. ${EVAL_SUFFIX}`,
  },
  style: {
    name: 'style',
    description: 'Voice/format verifier — tone, structure, and register match the ask.',
    prompt:
      "You are a style and voice verifier. Judge whether the answer's tone, formatting, and register match what the user " +
      "actually asked for. Flag unnecessary prose, marketing adjectives, excessive hedging, missing structure, and format " +
      "mismatches (for example, prose when code was asked for, or a wall of code when an explanation was asked for). Do " +
      `not rewrite — judge. ${EVAL_SUFFIX}`,
  },
  'test-coverage': {
    name: 'test-coverage',
    description: 'Test-coverage verifier — enumerates the tests that would fail on this answer.',
    prompt:
      "You are a test-coverage verifier. Imagine writing the test suite that would exercise the proposed answer, and ask " +
      "which tests would fail. Enumerate the untested branches, boundary conditions, and adversarial inputs the answer " +
      "quietly ignores. An answer that works on the happy path only, or that passes by redefining the contract, should be " +
      `flagged for revision. ${EVAL_SUFFIX}`,
  },
  clarity: {
    name: 'clarity',
    description: 'Clarity verifier — is the answer actually understandable and actionable?',
    prompt:
      "You are a clarity verifier. Judge whether a competent engineer reading this answer cold could act on it without " +
      "confusion. Flag ambiguous pronouns, under-specified steps, missing definitions of domain terms, and jargon left " +
      "unexplained at first use. A technically correct answer that cannot be followed should still be flagged for " +
      `revision. ${EVAL_SUFFIX}`,
  },
  completeness: {
    name: 'completeness',
    description: 'Completeness verifier — did it address every explicit sub-request?',
    prompt:
      "You are a completeness verifier. Re-read the user's question and enumerate every explicit sub-request; check that " +
      "the proposed answer addresses each one. Flag any sub-request that is skipped, deferred, or only partially covered. " +
      "An answer that solves the easy half while quietly dropping the hard half should be flagged, no matter how polished " +
      `the easy half is. ${EVAL_SUFFIX}`,
  },
};

/** Parse a simple `---`-delimited YAML-ish front-matter header. Returns { meta, body }. */
function parseFrontMatter(text) {
  const s = String(text || '');
  if (!s.startsWith('---')) return { meta: {}, body: s.trim() };
  const end = s.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: s.trim() };
  const header = s.slice(3, end).trim();
  const body = s.slice(end + 4).replace(/^\r?\n/, '').trim();
  const meta = {};
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    meta[m[1].toLowerCase()] = m[2].replace(/^["'](.*)["']$/, '$1');
  }
  return { meta, body };
}

/** Load a user-override persona from $GOLDUCK_HOME/personas/<name>.md, or null. */
function loadUserPersona(key) {
  if (!key || !/^[a-z0-9][a-z0-9_-]*$/i.test(key)) return null;
  const p = join(HOME(), 'personas', `${key}.md`);
  try {
    if (!existsSync(p)) return null;
    const { meta, body } = parseFrontMatter(readFileSync(p, 'utf8'));
    if (!body.length) return null;
    return {
      name: key,
      prompt: body,
      description: typeof meta.description === 'string' ? meta.description : '',
    };
  } catch { return null; }
}

/**
 * Resolve a persona name to `{ name, prompt, description }`, or null if unknown.
 * User overrides under $GOLDUCK_HOME/personas/<name>.md take precedence over builtins.
 */
export function resolvePersona(name) {
  if (!name) return null;
  const key = String(name).toLowerCase().trim();
  return loadUserPersona(key) ?? BUILTIN_PERSONAS[key] ?? null;
}

/** Sorted list of all persona names (built-in + user overrides). */
export function listPersonas() {
  const names = new Set(Object.keys(BUILTIN_PERSONAS));
  try {
    const dir = join(HOME(), 'personas');
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        const stem = f.slice(0, -3).toLowerCase();
        if (stem === 'readme' || stem === 'index' || stem.startsWith('_') || stem.startsWith('.')) continue;
        names.add(stem);
      }
    }
  } catch { /* ignore */ }
  return [...names].sort();
}

/** Reviewer + adversary + planner, for seeding panel_verify's default roster. */
export function defaultTrio() {
  return TRIO_NAMES.map((n) => BUILTIN_PERSONAS[n]).filter(Boolean);
}
