/* ─────────────────────────────────────────────────────────────────────────
 * golduck memory tools (runtime/tools/memory.mjs)
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const PIN = () => join(HOME(), 'memory', 'pins.json');
const FACTS = () => join(HOME(), 'memory', 'facts.jsonl');
const JOURNAL = () => join(HOME(), 'memory', 'journal.jsonl');

function loadPins() {
  try { return existsSync(PIN()) ? JSON.parse(readFileSync(PIN(), 'utf8')) : []; }
  catch { return []; }
}
function savePins(p) {
  mkdirSync(dirname(PIN()), { recursive: true });
  // Preserve future-compat: pins.json may gain a schema marker later. Keep
  // the current shape as a plain array so readers that don't know about
  // schemas still work.
  writeFileSync(PIN(), JSON.stringify(p, null, 2));
}
/** Current pins.json schema version. Bump when the stored shape changes. */
export const PINS_SCHEMA_VERSION = 1;

export const SCHEMAS = [
  {
    name: 'memory_set',
    description:
      'Persist a fact (pin) to golduck memory. Pins are injected into every future run as part of the system bundle.',
    input_schema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string', description: 'Short unique identifier.' },
        value: { type: 'string' },
        scope: { type: 'string', default: 'global' },
      },
    },
  },
  {
    name: 'memory_get',
    description: 'Retrieve a pinned fact by key.',
    input_schema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
        scope: { type: 'string', default: 'global' },
      },
    },
  },
  {
    name: 'memory_list',
    description: 'List all pinned facts (current session + global).',
    input_schema: { type: 'object', properties: { scope: { type: 'string' } } },
  },
  {
    name: 'memory_search',
    description: 'Search pinned facts by regex pattern on key or value.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        scope: { type: 'string', default: 'global' },
      },
    },
  },
  {
    name: 'memory_fact_append',
    description:
      'Append a durable fact to memory/facts.jsonl. Facts are surfaced via recall() into future system bundles. '
      + 'Use for stable truths about the user/repo/project (e.g. "team uses TypeScript everywhere", "CI runs on Bazel").',
    input_schema: {
      type: 'object',
      required: ['fact'],
      properties: {
        fact: { type: 'string', description: 'Single concise fact (<=280 chars).' },
        tags: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: 'Optional source hint: user|verify|auto|manual.' },
      },
    },
  },
  {
    name: 'memory_journal_append',
    description: 'Append a dated entry to the run journal. Used for post-run reflections.',
    input_schema: {
      type: 'object',
      required: ['entry'],
      properties: {
        entry: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

export async function memory_set({ key, value, scope = 'global' }) {
  const pins = loadPins().filter((p) => !(p.key === key && (p.scope || 'global') === scope));
  pins.push({ key, value: String(value), scope, ts: new Date().toISOString() });
  savePins(pins);
  return { ok: true, key, scope, count: pins.length };
}

export async function memory_get({ key, scope = 'global' }) {
  const pins = loadPins();
  const hit = pins.find((p) => p.key === key && (p.scope || 'global') === scope);
  if (!hit) return { ok: false, error: `not_found: ${key}` };
  return { ok: true, ...hit };
}

export async function memory_list({ scope = null } = {}) {
  const pins = loadPins();
  const filtered = scope ? pins.filter((p) => (p.scope || 'global') === scope) : pins;
  return { ok: true, count: filtered.length, pins: filtered };
}

export async function memory_search({ pattern, scope = null }) {
  const re = (() => { try { return new RegExp(pattern, 'i'); } catch { return null; } })();
  const pins = loadPins().filter((p) => !scope || (p.scope || 'global') === scope);
  const hits = pins.filter((p) => {
    if (!re) return p.key.includes(pattern) || p.value.includes(pattern);
    return re.test(p.key) || re.test(p.value);
  });
  return { ok: true, count: hits.length, pins: hits };
}

export async function memory_journal_append({ entry, tags = [] }) {
  const f = JOURNAL();
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify({
    ts: new Date().toISOString(),
    entry: String(entry),
    tags,
    run_id: process.env.GOLDUCK_RUN_ID || null,
  }) + '\n');
  return { ok: true };
}

export async function memory_fact_append({ fact, tags = [], source = 'manual' }) {
  try {
    const f = FACTS();
    mkdirSync(dirname(f), { recursive: true });
    const trimmed = String(fact || '').trim();
    if (!trimmed) return { ok: false, error: 'empty_fact' };
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      fact: trimmed.slice(0, 280),
      tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
      source,
      run_id: process.env.GOLDUCK_RUN_ID || null,
    }) + '\n';
    appendFileSync(f, line);
    return { ok: true, file: f, length: trimmed.length };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}
