/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI — slash command dispatcher (runtime/tui/commands.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * The single source of truth for what `/…` invocations mean inside the TUI.
 *
 * Layers:
 *   - COMMANDS      — catalogue (used by Commands palette + Help overlay)
 *   - match()       — turns raw composer text into { cmd, args }
 *   - filter()      — autocomplete-friendly filtered list
 *   - dispatch()    — executes a command against (store, setOverlay, engine)
 *                     and returns { handled, injection?, toast? }
 *     injection  → a string to forward to the engine as a user turn
 *                  (instead of the raw slash text), or null to consume
 *     toast      → optional { message, kind } to flash in the TUI
 *
 * The dispatcher is side-effectful on purpose: it pokes the store, opens
 * overlays, persists pins, resets history, etc. But it NEVER calls the
 * Anthropic API itself — that stays in engine_tui.mjs.
 * ───────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { recall } from '../memory/recall.mjs';
import { exportCsv } from './metrics_export.mjs';
import { forceVerifyLastTurn } from './verify_bridge.mjs';
import { undoLast } from './patch_snapshot.mjs';
import { detectProvider, listProviders, resolveAuthKey } from '../providers/registry.mjs';

const HOME = () => process.env.GOLDUCK_HOME || join(homedir(), '.golduck');

export const COMMANDS = [
  { name: '/help',     desc: 'show help overlay (hotkeys + commands)',         opens: 'help' },
  { name: '/commands', desc: 'open slash-command palette',                     opens: 'commands' },
  { name: '/memory',   desc: 'browse pinned facts + lessons',                  opens: 'memory' },
  { name: '/skills',   desc: 'browse installed prompt skills',                 opens: 'skills' },
  { name: '/tools',    desc: 'list every tool exposed to the model',           opens: 'tools' },
  { name: '/trace',    desc: 'live-tail the current run trace',                opens: 'trace' },
  { name: '/stats',    desc: 'cross-run usage/cost/latency dashboard',         opens: 'stats' },
  { name: '/sessions', desc: 'list + resume previous sessions',                opens: 'sessions' },
  { name: '/resume',   desc: '/resume <id> — rehydrate a prior session into the TUI' },
  { name: '/plan',     desc: 'view / run the current plan overlay',            opens: 'plan' },
  { name: '/diff',     desc: 'show the last apply_patch as a diff viewer',     opens: 'diff' },
  { name: '/undo',     desc: 'revert the most recent apply_patch snapshot' },
  { name: '/bundle',   desc: 'view the current live system bundle (^B)',          opens: 'bundle' },
  { name: '/mcp',      desc: 'inspect configured MCP servers (^Y)',               opens: 'mcp' },
  { name: '/reflect',  desc: 'browse lessons extracted from prior runs (^F)',     opens: 'reflect' },
  { name: '/doctor',   desc: 'live health check: proxy / daemon / MCP (^V)',        opens: 'doctor' },
  { name: '/agents',   desc: 'recent spawn_agent / rlm sub-agent activity',            opens: 'agents' },
  { name: '/metrics',  desc: 'latency p50/p95/p99 + think-to-output ratios',            opens: 'metrics' },
  { name: '/persona',  desc: 'inspect the active verify-panel persona roster',          opens: 'persona' },
  { name: '/bench',    desc: 'quality metrics vs saved baseline',                         opens: 'bench' },
  { name: '/metrics-export', desc: 'dump recent-run metrics to a CSV under ~/.golduck/state/exports/' },
  { name: '/rev',      desc: 'reverse-search prior user prompts (^R)',                   opens: 'rev' },
  { name: '/spend',    desc: 'session + lifetime budget ledger',                          opens: 'spend' },
  { name: '/dag',      desc: 'declared DAGs + active DAG run status',                     opens: 'dag' },
  { name: '/workspace',desc: 'git status + branch + recent commits (^W)',                opens: 'workspace' },
  { name: '/reset',    desc: 'clear conversation history (keep banner/session)' },
  { name: '/clear',    desc: 'alias of /reset' },
  { name: '/compact',  desc: 'ask the engine to compact the transcript on the next turn' },
  { name: '/save',     desc: 'persist the current session to ~/.golduck/state/sessions/' },
  { name: '/export',   desc: 'dump the transcript as a markdown file under ~/.golduck/state/exports/' },
  { name: '/tokens',   desc: 'flash current context % and token usage' },
  { name: '/cost',     desc: 'flash current session spend' },
  { name: '/verify',   desc: 'force-verify the last assistant response' },
  { name: '/recall',   desc: '/recall <q> — search cross-session memory inline' },
  { name: '/pin',      desc: '/pin <key>=<value> — persist a fact for future runs' },
  { name: '/read',     desc: '/read <path> — inject file contents into next message' },
  { name: '/model',    desc: '/model <slug> — override model for this session' },
  { name: '/providers',desc: 'list configured providers + which have API keys set' },
  { name: '/think',    desc: '/think <low|medium|high|xhigh> — adjust thinking budget' },
  { name: '/busy',     desc: 'toggle a fake busy indicator (debug)' },
  { name: '/ask',      desc: '/ask <q> — quick one-shot answer (no verify loop)' },
  { name: '/theme',    desc: '/theme <dark|light|classic> — change the color palette' },
  { name: '/exit',     desc: 'quit golduck' },
  { name: '/quit',     desc: 'alias of /exit' },
];

/** Parse a composer line into { cmd, rest }. Returns null if not a slash cmd. */
export function parseSlash(line) {
  const s = String(line || '').trim();
  if (!s.startsWith('/')) return null;
  const sp = s.indexOf(' ');
  if (sp === -1) return { cmd: s.toLowerCase(), rest: '' };
  return { cmd: s.slice(0, sp).toLowerCase(), rest: s.slice(sp + 1).trim() };
}

/** Filter the catalogue against a partial user input (for the palette). */
export function filterCommands(partial) {
  const q = String(partial || '').toLowerCase().trim();
  if (!q || q === '/') return COMMANDS;
  const core = q.replace(/^\//, '');
  // Prefix matches always first; substring-in-description only when ≥ 3 chars.
  const byPrefix = COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  if (byPrefix.length > 0 || core.length < 3) return byPrefix;
  return COMMANDS.filter((c) => c.desc.toLowerCase().includes(core));
}

function readTextSafe(p) {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; }
}

function pinsFile() { return join(HOME(), 'memory', 'pins.json'); }

function loadPins() {
  try { return existsSync(pinsFile()) ? JSON.parse(readFileSync(pinsFile(), 'utf8')) : []; }
  catch { return []; }
}

function savePins(p) {
  mkdirSync(dirname(pinsFile()), { recursive: true });
  writeFileSync(pinsFile(), JSON.stringify(p, null, 2));
}

/** Heuristic JSON → human lines for tokens/cost display. */
function humanUsd(n) { return `$${Number(n || 0).toFixed(4)}`; }

/**
 * Dispatch a parsed slash command.
 * @param {object} o
 * @param {string} o.line          raw composer text ("/pin foo=bar")
 * @param {object} o.store         runtime/tui/store.mjs singleton
 * @param {(o:string|null)=>void} o.setOverlay   overlay name setter in App state
 * @param {(m:object)=>void} o.setToast          toast setter in App state
 * @param {(text:string)=>void} o.submitEngine   forwards text to the engine loop
 *                                               (same path as regular composer submit)
 * @returns {{handled:boolean, injection?:string, toast?:{message:string,kind:string}}}
 */
export function dispatchSlash({ line, store, setOverlay, setToast, submitEngine }) {
  const parsed = parseSlash(line);
  if (!parsed) return { handled: false };
  const { cmd, rest } = parsed;
  const state = store.state;

  const openAndDone = (name) => { setOverlay?.(name); return { handled: true }; };
  const toastAndDone = (message, kind = 'info') => {
    setToast?.({ message, kind });
    return { handled: true };
  };

  switch (cmd) {
    case '/help':     return openAndDone('help');
    case '/commands': return openAndDone('commands');
    case '/memory':   return openAndDone('memory');
    case '/skills':   return openAndDone('skills');
    case '/tools':    return openAndDone('tools');
    case '/trace':    return openAndDone('trace');
    case '/stats':    return openAndDone('stats');
    case '/sessions': return openAndDone('sessions');
    case '/plan':     return openAndDone('plan');
    case '/diff':     return openAndDone('diff');
    case '/bundle':   return openAndDone('bundle');
    case '/mcp':      return openAndDone('mcp');
    case '/reflect':  return openAndDone('reflect');
    case '/doctor':   return openAndDone('doctor');
    case '/agents':   return openAndDone('agents');
    case '/metrics':  return openAndDone('metrics');
    case '/persona':  return openAndDone('persona');
    case '/bench':    return openAndDone('bench');
    case '/rev':      return openAndDone('rev');
    case '/spend':    return openAndDone('spend');
    case '/dag':      return openAndDone('dag');
    case '/workspace':return openAndDone('workspace');

    case '/reset':
    case '/clear': {
      store.reset();
      return toastAndDone('conversation cleared', 'ok');
    }

    case '/exit':
    case '/quit':
      submitEngine?.('/exit');  // engine loop breaks on "/exit"
      return { handled: true };

    case '/compact':
      return {
        handled: true,
        injection:
          'System: Please compact the transcript now. Summarize everything so far so that subsequent turns are cheaper. Then wait for the next user turn.',
      };

    case '/resume': {
      const id = rest.trim();
      if (!id) return toastAndDone('usage: /resume <id>', 'warn');
      const f = join(HOME(), 'state', 'sessions', `${id}.json`);
      if (!existsSync(f)) return toastAndDone(`session not found: ${id}`, 'error');
      let j;
      try { j = JSON.parse(readFileSync(f, 'utf8')); }
      catch (e) { return toastAndDone(`parse error: ${e.message}`, 'error'); }
      store.reset();
      // Track the most-recent tool_use id per tool so we can pair up tool_result
      // blocks when we walk a tool_result-bearing user message.
      const pendingToolIds = new Map(); // tool_use_id → { name, started }
      let tools_replayed = 0;
      for (const m of (j.messages || [])) {
        if (m.role === 'user') {
          // Detect tool_result user messages: they carry an array of tool_result blocks.
          if (Array.isArray(m.content)) {
            const trs = m.content.filter((b) => b && b.type === 'tool_result');
            for (const tr of trs) {
              const meta = pendingToolIds.get(tr.tool_use_id);
              const summary = typeof tr.content === 'string'
                ? tr.content.slice(0, 300)
                : JSON.stringify(tr.content || {}).slice(0, 300);
              store.push('tool_done', {
                id: tr.tool_use_id,
                ok: !tr.is_error,
                summary,
                duration_ms: null,
              });
              if (meta) pendingToolIds.delete(tr.tool_use_id);
              tools_replayed += 1;
            }
            // Any plain text blocks alongside the tool_result become a user turn.
            const text = m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
            if (text) store.push('user', { text });
          } else if (typeof m.content === 'string') {
            store.push('user', { text: m.content });
          }
        } else if (m.role === 'assistant' && Array.isArray(m.content)) {
          store.push('assistant_start', {});
          for (const b of m.content) {
            if (b.type === 'text') store.push('assistant_text', { delta: b.text || '' });
            if (b.type === 'tool_use') {
              const id = b.id || `x-${Math.random()}`;
              pendingToolIds.set(id, { name: b.name, started: Date.now() });
              store.push('tool_use', { id, name: b.name, input: b.input || {} });
            }
          }
        }
      }
      return toastAndDone(`resumed ${id} (${(j.messages || []).length} messages, ${tools_replayed} tool results)`, 'ok');
    }
    case '/metrics-export': {
      const r = exportCsv({ home: HOME() });
      if (r.path) {
        return toastAndDone(`metrics CSV → ${r.path.replace(process.env.HOME || '', '~')}  (${r.rows} rows)`, 'ok');
      }
      return toastAndDone(`metrics-export failed: ${r.error || 'unknown'}`, 'error');
    }
    case '/export': {
      const dir = join(HOME(), 'state', 'exports');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `golduck-${Date.now()}.md`);
      const lines = ['# golduck session export', ''];
      lines.push(`- exported_at: ${new Date().toISOString()}`);
      lines.push(`- entries: ${state.entries.length}`);
      lines.push('');
      for (const e of state.entries) {
        if (e.kind === 'user') {
          lines.push('## user', e.text || '', '');
        } else if (e.kind === 'assistant') {
          lines.push('## assistant', e.text || '', '');
        } else if (e.kind === 'tool') {
          lines.push(`## tool: ${e.name}`,
            '```', JSON.stringify(e.input || {}, null, 2), '```',
            `status: ${e.status}  duration_ms: ${e.duration_ms ?? '?'}`, '',
            e.summary ? '> ' + String(e.summary).slice(0, 500) : '', '');
        } else if (e.kind === 'verify') {
          lines.push(`## verify: ${e.verdict}  conf=${e.confidence}`, (e.issues || []).map((i) => '- ' + i).join('\n'), '');
        } else if (e.kind === 'handoff') {
          lines.push('## handoff', '```json', JSON.stringify(e, null, 2), '```', '');
        }
      }
      writeFileSync(file, lines.join('\n'));
      return toastAndDone(`exported → ${file.replace(process.env.HOME || '', '~')}`, 'ok');
    }
    case '/save': {
      // Soft signal — the engine_tui persists per-turn; here we just confirm.
      return toastAndDone('session persistence runs every turn; check ~/.golduck/state/sessions/', 'ok');
    }

    case '/tokens': {
      const s = state.statusLine || {};
      return toastAndDone(`ctx=${s.ctx_pct ?? 0}%  spend=${humanUsd(s.usd)}  tools=${s.tools ?? '?'}`, 'info');
    }
    case '/cost': {
      const s = state.statusLine || {};
      return toastAndDone(`session spend: ${humanUsd(s.usd)}`, 'info');
    }

    case '/undo': {
      const r = undoLast({ runId: process.env.GOLDUCK_RUN_ID });
      if (!r.ok) return toastAndDone(`undo: ${r.error || 'failed'}`, 'warn');
      const msg = `undo slot ${r.slot}: restored ${r.restored.length}${r.deleted.length ? `, deleted ${r.deleted.length}` : ''}`;
      return toastAndDone(msg, 'ok');
    }
    case '/verify': {
      // Fire the inline verifier asynchronously — it will push a 'verify' event
      // to the store when done; we only acknowledge here so the user sees the
      // TUI immediately react.
      (async () => {
        try {
          // We don't have direct access to `messages` here; pass a no-op and let
          // the bridge pull the last assistant text out of the store's entries.
          const fakeMessages = (store?.state?.entries || []).map((e) => {
            if (e.kind === 'user') return { role: 'user', content: e.text || '' };
            if (e.kind === 'assistant') return { role: 'assistant', content: [{ type: 'text', text: e.text || '' }] };
            return null;
          }).filter(Boolean);
          await forceVerifyLastTurn({ store, messages: fakeMessages, routed: {} });
        } catch {}
      })();
      return toastAndDone('verifying last turn…', 'info');
    }

    case '/recall': {
      const q = rest.trim();
      if (!q) return toastAndDone('usage: /recall <query>', 'warn');
      const hits = recall({ query: q, k: 5 });
      store.push('recall', { hits, query: q });
      if (!hits.length) return toastAndDone(`no memory hits for “${q}”`, 'warn');
      return { handled: true };
    }

    case '/pin': {
      const eq = rest.indexOf('=');
      if (eq < 1) return toastAndDone('usage: /pin <key>=<value>', 'warn');
      const key = rest.slice(0, eq).trim();
      const value = rest.slice(eq + 1).trim();
      if (!key || !value) return toastAndDone('usage: /pin <key>=<value>', 'warn');
      const pins = loadPins().filter((p) => !(p.key === key && (p.scope || 'global') === 'global'));
      pins.push({ key, value, scope: 'global', ts: new Date().toISOString() });
      savePins(pins);
      return toastAndDone(`pinned “${key}” (${pins.length} total)`, 'ok');
    }

    case '/read': {
      const p = rest.trim();
      if (!p) return toastAndDone('usage: /read <path>', 'warn');
      const abs = resolve(process.cwd(), p);
      const body = readTextSafe(abs);
      if (body == null) return toastAndDone(`cannot read: ${p}`, 'error');
      const clipped = body.length > 40_000 ? body.slice(0, 40_000) + '\n…(truncated)' : body;
      return {
        handled: true,
        injection:
          `Attached file \`${p}\` for context (${body.length} bytes):\n\n\`\`\`\n${clipped}\n\`\`\`\n\nWhat should we do with it?`,
      };
    }

    case '/model': {
      const slug = rest.trim();
      if (!slug) {
        const cur = state.banner?.model || process.env.GOLDUCK_MODEL || 'claude-opus-4-7';
        const prov = detectProvider(cur);
        const haveKey = prov.adapter === 'anthropic' || Boolean(resolveAuthKey(prov));
        const tag = haveKey ? 'ready' : 'MISSING API KEY';
        return toastAndDone(`current model: ${cur}  ·  provider: ${prov.label}  ·  ${tag}`, haveKey ? 'info' : 'warn');
      }
      const prov = detectProvider(slug);
      const haveKey = prov.adapter === 'anthropic' || Boolean(resolveAuthKey(prov));
      process.env.GOLDUCK_MODEL = slug;
      store.push('banner', { ...(state.banner || {}), model: slug, tier: prov.name });
      if (!haveKey) {
        return toastAndDone(
          `model → ${slug} (${prov.label}) but NO key in ${prov.authEnvs.join('/')} — calls will fail`,
          'warn',
        );
      }
      return toastAndDone(`model → ${slug} (${prov.label}, key ok) — applies next turn`, 'ok');
    }

    case '/providers': {
      // Render as a 'recall'-shaped cell so the list has a real cell in
      // history (not a one-line toast). Each row becomes a hit: kind=name,
      // score=1/0 for key present/absent, text=label with status glyph.
      const rows = listProviders();
      const hits = rows.map((p) => ({
        kind: p.name,
        score: p.hasKey ? 1 : 0,
        text: `${p.hasKey ? '✓' : '·'} ${p.label}${p.hasKey ? '' : '  (no key)'}`,
      }));
      store.push('recall', { hits, query: 'providers (✓ = key configured)' });
      return { handled: true };
    }

    case '/think': {
      const level = rest.trim().toLowerCase();
      const map = { low: 4000, medium: 12000, high: 32000, xhigh: 64000 };
      if (!(level in map)) return toastAndDone('usage: /think <low|medium|high|xhigh>', 'warn');
      process.env.GOLDUCK_THINKING_BUDGET = String(map[level]);
      return toastAndDone(`thinking budget → ${map[level]} tokens (${level}), applies next turn`, 'ok');
    }

    case '/ask': {
      const q = rest.trim();
      if (!q) return toastAndDone('usage: /ask <question>', 'warn');
      process.env.GOLDUCK_VERIFY = 'off';
      return { handled: true, injection: q };
    }
    case '/theme': {
      const name = rest.trim().toLowerCase();
      const valid = ['dark','light','classic'];
      if (!name) return toastAndDone(`current: ${process.env.GOLDUCK_THEME || 'dark'}  ·  use /theme <${valid.join('|')}>`, 'info');
      if (!valid.includes(name)) return toastAndDone(`unknown theme: ${name}  ·  try ${valid.join(', ')}`, 'warn');
      process.env.GOLDUCK_THEME = name;
      return toastAndDone(`theme → ${name} (restart to fully apply)`, 'ok');
    }
    case '/busy': {
      const next = !state.busy;
      store.push('busy', { busy: next });
      return toastAndDone(next ? 'fake busy ON' : 'fake busy OFF', 'info');
    }

    default:
      return toastAndDone(`unknown command: ${cmd}  (try /help)`, 'warn');
  }
}
