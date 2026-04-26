/* ─────────────────────────────────────────────────────────────────────────
 * golduck model policy (runtime/engine/model_policy.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * One place to decide which model string every sub-system call uses.
 *
 * Precedence:
 *   1. Explicit caller argument.
 *   2. process.env.GOLDUCK_MODEL (set by the /model slash command).
 *   3. 'claude-opus-4-7' as the canonical default.
 *
 * Also exports MAIN_MODEL (alias) so callers can avoid typing the slug.
 * Having one source of truth means a future model-tier change touches this
 * file, not 15 scattered constants.
 * ───────────────────────────────────────────────────────────────────────── */

export const MAIN_MODEL = 'claude-opus-4-7';

export function resolveModel(explicit) {
  if (explicit && typeof explicit === 'string' && explicit.length > 0) return explicit;
  const env = process.env.GOLDUCK_MODEL;
  if (env && typeof env === 'string' && env.length > 0) return env;
  return MAIN_MODEL;
}
