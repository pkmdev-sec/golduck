/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool-input validator (runtime/engine/input_validate.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Very light JSON-schema validation focused on the common failure modes
 * we actually see from Opus — missing required params, wrong types on
 * top-level scalar fields, or completely mis-nested shapes.
 *
 * We DON'T implement full JSON Schema. We just catch:
 *   - missing required fields
 *   - type mismatch on top-level scalar properties when declared
 *   - required-looking strings that came in as objects or arrays
 *
 * On error: return { ok: false, error: '...', hint: '...' } so the engine
 * short-circuits dispatch and feeds a clear message back to the model.
 * ───────────────────────────────────────────────────────────────────────── */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function schemaTypeMatches(want, got) {
  if (!want) return true;
  if (want === 'integer' && (got === 'number')) return true;
  return want === got;
}

/** Recursive check: walks `schema` (which may itself have a nested
 *  object schema per-property) against `input`. Returns {ok, error, hint}.
 *  Caller can prepend a dotted path via `pathPrefix`. */
function _validateObject(schema, input, pathPrefix = '') {
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type && schema.type !== 'object') return { ok: true };
  const inp = input ?? {};

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in inp) || inp[key] == null) {
      const p = pathPrefix ? `${pathPrefix}.${key}` : key;
      return {
        ok: false,
        error: `missing_required_arg: ${p}`,
        hint: `Re-emit tool_use with ${JSON.stringify({ [key]: '<value>' }).replace(/[{}]/g, '').trim()} at ${p}.`,
      };
    }
  }

  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in inp) || inp[key] == null) continue;
    const want = spec.type;
    if (!want) continue;
    const got = typeOf(inp[key]);
    if (!schemaTypeMatches(want, got)) {
      const p = pathPrefix ? `${pathPrefix}.${key}` : key;
      return {
        ok: false,
        error: `type_mismatch: ${p} expected ${want}, got ${got}`,
        hint: `Re-emit tool_use with ${JSON.stringify({ [key]: `<${want}>` })} at ${p}.`,
      };
    }
    // Enum check: if the schema restricts values, enforce it for strings / numbers.
    if (Array.isArray(spec.enum) && spec.enum.length) {
      if (!spec.enum.includes(inp[key])) {
        const p = pathPrefix ? `${pathPrefix}.${key}` : key;
        return {
          ok: false,
          error: `enum_violation: ${p} expected one of ${JSON.stringify(spec.enum)}, got ${JSON.stringify(inp[key])}`,
          hint: `Pick one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}.`,
        };
      }
    }
    // Recurse into nested object schemas so nested 'required' also lands.
    if (want === 'object' && spec.properties) {
      const sub = _validateObject(spec, inp[key], pathPrefix ? `${pathPrefix}.${key}` : key);
      if (!sub.ok) return sub;
    }
  }

  return { ok: true };
}

export function validateToolInput(schema, input) {
  return _validateObject(schema, input, '');
}
