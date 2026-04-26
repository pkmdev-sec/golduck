/* ─────────────────────────────────────────────────────────────────────────
 * golduck exit codes (runtime/core/exit_codes.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Precise exit codes so shell scripts + CI can react intelligently:
 *
 *   0   success
 *   1   generic engine error (unknown)
 *   2   bad CLI args / usage
 *   3   governance gate blocked
 *   4   budget exhausted
 *   5   API error (4xx from Bedrock; usually bad request or auth)
 *   6   proxy unreachable / not running
 *   7   max_turns exceeded
 *   8   user interrupt (one SIGINT)
 *   99  unexpected fatal
 *   130 force-exit (two SIGINTs)
 * ───────────────────────────────────────────────────────────────────────── */
export const EXIT = {
  OK: 0,
  ENGINE_ERROR: 1,
  BAD_USAGE: 2,
  GATE_BLOCKED: 3,
  BUDGET_EXHAUSTED: 4,
  API_ERROR: 5,
  PROXY_UNREACHABLE: 6,
  MAX_TURNS: 7,
  USER_INTERRUPT: 8,
  FATAL: 99,
  FORCE_EXIT: 130,
};

export function codeFromError(e) {
  const msg = (e?.message || String(e || '')).toLowerCase();
  if (msg.includes('econnrefused') || msg.includes('connection refused')) return EXIT.PROXY_UNREACHABLE;
  if (msg.includes('enotfound')) return EXIT.PROXY_UNREACHABLE;
  if (msg.includes('invalid_request_error') || /http 4\d\d/.test(msg)) return EXIT.API_ERROR;
  if (msg.includes('budget')) return EXIT.BUDGET_EXHAUSTED;
  if (msg.includes('max_turns')) return EXIT.MAX_TURNS;
  return EXIT.ENGINE_ERROR;
}
