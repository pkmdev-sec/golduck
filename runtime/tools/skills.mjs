/* ─────────────────────────────────────────────────────────────────────────
 * golduck skills tool (runtime/tools/skills.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Skills are reusable prompt recipes stored as JSON in
 * $GOLDUCK_HOME/skills/<name>.json. Shape:
 *
 *   {
 *     "name": "summarize-diff",
 *     "description": "...",
 *     "system": "...",                 // overrides the default system
 *     "user_template": "...{{diff}}...",
 *     "required_args": ["diff"],
 *     "max_tokens": 4000,
 *     "thinking_budget": 4000,         // optional
 *   }
 *
 * skill_invoke renders the template with the given args, runs a single
 * Opus 4.7 call, and returns the assistant text. No tools are exposed
 * to skills (keeps them focused).
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { streamMessages, buildRequestBody } from '../engine/client.mjs';
import { resolveModel } from '../engine/model_policy.mjs';

function skillsDir() {
  return join(process.env.GOLDUCK_HOME || join(homedir(), '.golduck'), 'skills');
}

function loadSkill(name) {
  const f = join(skillsDir(), `${name}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function render(tmpl, args) {
  return String(tmpl || '').replace(/\{\{(\w+)\}\}/g, (_, k) => args[k] != null ? String(args[k]) : '');
}

export const SCHEMAS = [
  {
    name: 'skill_invoke',
    description:
      'Invoke a user-defined skill (prompt recipe) from $GOLDUCK_HOME/skills/<name>.json. ' +
      'Skills are reusable templated prompts with no tool access — ideal for things like ' +
      'summarize-diff, extract-entities, translate, etc. Returns the assistant text.',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Skill name (filename without .json).' },
        arguments: { type: 'object', description: 'Args to interpolate into the skill template.' },
      },
    },
  },
  {
    name: 'skill_list',
    description: 'List user-installed skills with their descriptions.',
    input_schema: { type: 'object', properties: {} },
  },
];

export async function skill_invoke({ name, arguments: args = {} }) {
  const s = loadSkill(name);
  if (!s) return { ok: false, error: `skill_not_found: ${name}` };
  // Verify required args.
  for (const r of (s.required_args || [])) {
    if (!(r in args)) return { ok: false, error: `missing_required_arg: ${r}` };
  }
  const system = s.system || 'You are a focused assistant. Answer directly.';
  const user = render(s.user_template || '{{input}}', args);
  const body = buildRequestBody({
    model: resolveModel(),
    system: [{ type: 'text', text: system }],
    messages: [{ role: 'user', content: user }],
    max_tokens: s.max_tokens || 8000,
    thinking: s.thinking_budget ? { type: 'enabled', budget_tokens: s.thinking_budget } : null,
    temperature: 1.0,
  });
  const it = streamMessages(body);
  let text = '', usage = {};
  for await (const ev of it) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text || '';
    if (ev.type === 'message_start' && ev.message?.usage) usage = { ...usage, ...ev.message.usage };
    if (ev.type === 'message_delta' && ev.usage) usage = { ...usage, ...ev.usage };
  }
  return { ok: true, text: text.trim(), usage, skill: name };
}

export async function skill_list() {
  const dir = skillsDir();
  if (!existsSync(dir)) return { ok: true, skills: [] };
  try {
    const skills = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      const s = loadSkill(f.replace(/\.json$/, ''));
      return { name: f.replace(/\.json$/, ''), description: s?.description || '' };
    });
    return { ok: true, skills };
  } catch (e) { return { ok: false, error: String(e) }; }
}
