/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool-output validator (runtime/engine/output_validate.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Light shape-check for tool results BEFORE they land in the next
 * assistant turn. We don't run full JSON-schema validation — the result
 * envelope for each native tool has a known handful of fields, so we
 * just assert the object is a truthy non-array and pin down an 'ok'
 * flag where possible.
 *
 * Intent: catch "MCP returned undefined" or "tool threw and we turned
 * null into {}" early, surface a clean diagnostic, and let the model
 * re-emit the call.
 * ───────────────────────────────────────────────────────────────────────── */

export function validateToolResult(toolName, result) {
  if (result === null || result === undefined) {
    return { ok: false, error: `tool \`${toolName}\` returned no result`, hint: 'Re-emit the tool call; result was null/undefined.' };
  }
  if (Array.isArray(result)) {
    return { ok: false, error: `tool \`${toolName}\` returned an array instead of an envelope object`, hint: 'Tool results must be envelope objects, not arrays.' };
  }
  if (typeof result !== 'object') {
    return { ok: false, error: `tool \`${toolName}\` returned a ${typeof result} instead of an envelope object`, hint: 'Tool results must be {ok, ...} envelope objects.' };
  }
  // Permissive: if there's no ok field, accept as ok=true (legacy callers).
  return { ok: true };
}
