#!/usr/bin/env node
/* golduck sessions — list / show / resume helper. */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
const DIR  = join(HOME, 'state', 'sessions');

function list() {
  if (!existsSync(DIR)) { console.log('no sessions yet'); return; }
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f.replace(/\.json$/, ''), full: join(DIR, f) }))
    .sort((a, b) => statSync(b.full).mtimeMs - statSync(a.full).mtimeMs);
  if (!files.length) { console.log('no sessions yet'); return; }
  for (const f of files.slice(0, 50)) {
    try {
      const j = JSON.parse(readFileSync(f.full, 'utf8'));
      const mc = (j.messages || []).length;
      console.log(`${f.name}  updated=${j.updated_at || '-'}  messages=${mc}  model=${j.model || '-'}`);
    } catch {}
  }
}

function show(id) {
  const f = join(DIR, `${id}.json`);
  if (!existsSync(f)) { console.error('not found:', id); process.exit(2); }
  const j = JSON.parse(readFileSync(f, 'utf8'));
  console.log(JSON.stringify({
    updated_at: j.updated_at, model: j.model,
    message_count: (j.messages || []).length,
    messages_head: (j.messages || []).slice(0, 3),
    messages_tail: (j.messages || []).slice(-3),
  }, null, 2));
}

function exportMd(id) {
  const f = join(DIR, `${id}.json`);
  if (!existsSync(f)) { console.error('not found:', id); process.exit(2); }
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const lines = [];
  lines.push(`# golduck session ${id}`);
  lines.push(``);
  lines.push(`- updated_at: ${j.updated_at}`);
  lines.push(`- model: ${j.model}`);
  lines.push(`- messages: ${(j.messages||[]).length}`);
  lines.push(``);
  for (const m of j.messages || []) {
    if (m.role === 'user') {
      const text = Array.isArray(m.content)
        ? m.content.map((b) => b.type === 'tool_result' ? `\n> [tool_result ${b.tool_use_id}] ${String(b.content || '').slice(0, 200)}` : (b.text || '')).join('\n')
        : String(m.content);
      lines.push(`## user`); lines.push(text); lines.push(``);
    } else if (m.role === 'assistant') {
      const text = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const tools = (m.content || []).filter((b) => b.type === 'tool_use').map((b) => `- ${b.name}(${JSON.stringify(b.input).slice(0, 120)})`).join('\n');
      lines.push(`## assistant`);
      if (tools) { lines.push(`**tools:**`); lines.push(tools); }
      if (text)  { lines.push(text); }
      lines.push(``);
    }
  }
  process.stdout.write(lines.join('\n'));
}

const cmd = process.argv[2] || 'list';
if (cmd === 'list') list();
else if (cmd === 'show') show(process.argv[3]);
else if (cmd === 'export') exportMd(process.argv[3]);
else { console.error('usage: golduck sessions list|show <id>|export <id>'); process.exit(2); }
