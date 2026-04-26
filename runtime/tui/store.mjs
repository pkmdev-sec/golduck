/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI event store (runtime/tui/store.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Tiny ink-friendly event bus + state container. The engine emits events
 * via store.push(kind, payload); the React tree subscribes via a hook.
 *
 * Event kinds:
 *   banner           { model, tier, thinking, verify, reflect, budget, ... }
 *   user             { text }
 *   assistant_start
 *   assistant_text   { delta }
 *   thinking_summary { lines, chars, preview }
 *   tool_use         { id, name, input }
 *   tool_done        { id, ok, summary, duration_ms }
 *   usage            { input, output, cache_read, cache_write, usd, ctx_pct }
 *   verify           { verdict, confidence, issues[] }
 *   handoff          { tools_used{}, files_touched[], spend }
 *   compact          { est_tokens }
 *   error            { message }
 *   recall           { hits[], query }                   (new)
 *   tool_catalog     { tools[] }                          (new — banner counter + Tools overlay)
 *   busy             { busy:boolean, label?:string }      (new — spinner ticker + status line)
 *   plan             { goal, steps[] }                    (new — rendered via PlanCell)
 *   skill_started    { name }                             (new)
 *   skill_done       { name, ok, summary }                (new)
 *   notice           { message, kind }                    (soft toast source)
 * ───────────────────────────────────────────────────────────────────────── */

class Store {
  constructor() {
    this.state = {
      banner: null,
      sessionStart: Date.now(),
      entries: [],            // array of rendered cells (user/assistant/tool/thinking/handoff/…)
      currentAssistant: null, // accumulating text + usage
      usage: null,            // per-turn usage
      statusLine: null,       // model, tier, ctx%, spend
      error: null,
      busy: false,
      busyLabel: null,
      toolCatalog: [],        // full tool registry for Tools overlay
      lastRecall: null,       // { hits, query }
      notice: null,           // latest soft notice (kind/message)
      stream: null,           // { startedAt, tokens } while assistant is streaming
    };
    this.listeners = new Set();
  }

  subscribe(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  emit() {
    // Send a fresh top-level reference so React's setState actually re-renders.
    this.state = { ...this.state };
    // Coalesce rapid-fire pushes into a single flush per microtask so ink
    // doesn't rerender N times when tokens stream in bursts.
    if (this._flushPending) return;
    this._flushPending = true;
    queueMicrotask(() => {
      this._flushPending = false;
      for (const cb of this.listeners) cb(this.state);
    });
  }

  push(kind, payload = {}) {
    if (process.env.GOLDUCK_DEBUG_STORE === '1') {
      try {
        process.stderr.write(`[STORE] ${kind} ${JSON.stringify(payload || {}).slice(0, 200)}\n`);
      } catch {}
    }
    switch (kind) {
      case 'banner':
        this.state.banner = { ...(this.state.banner || {}), ...payload };
        this.state.statusLine = {
          model:   this.state.banner.model,
          tier:    this.state.banner.tier,
          usd:     this.state.statusLine?.usd || 0,
          ctx_pct: this.state.statusLine?.ctx_pct || 0,
          tools:   this.state.banner.toolCount ?? this.state.statusLine?.tools ?? 0,
        };
        break;

      case 'user':
        this.state.entries.push({ kind: 'user', id: `u-${Date.now()}-${Math.random()}`, text: payload.text });
        this.state.currentAssistant = null;
        break;

      case 'assistant_start':
        this.state.currentAssistant = { kind: 'assistant', id: `a-${Date.now()}-${Math.random()}`, text: '', usage: null };
        this.state.entries.push(this.state.currentAssistant);
        break;

      case 'assistant_text':
        if (this.state.currentAssistant) {
          const updated = {
            ...this.state.currentAssistant,
            text: (this.state.currentAssistant.text || '') + (payload.delta || ''),
          };
          const idx = this.state.entries.lastIndexOf(this.state.currentAssistant);
          const nextEntries = this.state.entries.slice();
          if (idx >= 0) nextEntries[idx] = updated;
          else nextEntries.push(updated);
          this.state.entries = nextEntries;
          this.state.currentAssistant = updated;
        }
        break;

      case 'thinking_summary':
        this.state.entries.push({
          kind: 'thinking', id: `t-${Date.now()}-${Math.random()}`,
          lines: payload.lines, chars: payload.chars, preview: payload.preview,
        });
        break;

      case 'tool_use':
        this.state.entries.push({
          kind: 'tool', id: payload.id, name: payload.name, input: payload.input,
          status: 'running', summary: '', duration_ms: null,
        });
        break;

      case 'tool_done': {
        const e = [...this.state.entries].reverse().find((x) => x.kind === 'tool' && x.id === payload.id);
        if (e) {
          e.status = payload.ok === false ? 'error' : 'ok';
          e.summary = payload.summary || '';
          e.duration_ms = payload.duration_ms;
        }
        this.state.entries = [...this.state.entries];
        break;
      }

      case 'usage':
        this.state.usage = payload;
        if (this.state.currentAssistant) this.state.currentAssistant.usage = payload;
        if (this.state.statusLine) {
          this.state.statusLine = {
            ...this.state.statusLine,
            usd: (this.state.statusLine.usd || 0) + (payload.usd || 0),
            ctx_pct: payload.ctx_pct ?? this.state.statusLine.ctx_pct,
          };
        }
        break;

      case 'verify':
        this.state.entries.push({
          kind: 'verify', id: `v-${Date.now()}-${Math.random()}`,
          verdict: payload.verdict, confidence: payload.confidence,
          issues: payload.issues || [],
        });
        break;

      case 'handoff':
        this.state.entries.push({ kind: 'handoff', id: `h-${Date.now()}-${Math.random()}`, ...payload });
        break;

      case 'compact':
        this.state.entries.push({ kind: 'compact', id: `c-${Date.now()}-${Math.random()}`, est_tokens: payload.est_tokens });
        break;

      case 'error':
        this.state.error = payload.message;
        this.state.entries.push({ kind: 'error', id: `e-${Date.now()}-${Math.random()}`, message: payload.message });
        break;

      case 'recall': {
        const hits = payload.hits || [];
        this.state.lastRecall = { hits, query: payload.query || null };
        if (hits.length) {
          this.state.entries.push({
            kind: 'recall', id: `r-${Date.now()}-${Math.random()}`,
            hits, query: payload.query,
          });
        }
        break;
      }

      case 'tool_catalog':
        this.state.toolCatalog = payload.tools || [];
        if (this.state.banner) {
          this.state.banner = { ...this.state.banner, toolCount: this.state.toolCatalog.length };
        }
        if (this.state.statusLine) {
          this.state.statusLine = { ...this.state.statusLine, tools: this.state.toolCatalog.length };
        }
        break;

      case 'busy':
        this.state.busy = Boolean(payload.busy);
        this.state.busyLabel = payload.label || null;
        break;

      case 'retry':
        this.state.entries.push({
          kind: 'retry', id: `rt-${Date.now()}-${Math.random()}`,
          attempt: payload.attempt, reason: payload.reason, wait_ms: payload.wait_ms,
        });
        break;
      case 'plan':
        this.state.entries.push({
          kind: 'plan', id: `p-${Date.now()}-${Math.random()}`,
          goal: payload.goal, steps: payload.steps || [],
        });
        break;

      case 'skill_started':
        this.state.entries.push({
          kind: 'tool', id: `skill-${Date.now()}-${Math.random()}`,
          name: `skill:${payload.name}`, input: payload.args || {},
          status: 'running', summary: '', duration_ms: null,
        });
        break;

      case 'skill_done': {
        const e = [...this.state.entries].reverse().find((x) => x.kind === 'tool' && x.name === `skill:${payload.name}` && x.status === 'running');
        if (e) {
          e.status = payload.ok === false ? 'error' : 'ok';
          e.summary = payload.summary || '';
          e.duration_ms = payload.duration_ms;
        }
        this.state.entries = [...this.state.entries];
        break;
      }

      case 'notice':
        this.state.notice = { id: `n-${Date.now()}-${Math.random()}`, message: payload.message, kind: payload.kind || 'info' };
        break;

      case 'stream_start':
        this.state.stream = { startedAt: Date.now(), tokens: 0 };
        break;
      case 'stream_tick':
        if (this.state.stream) {
          this.state.stream = { ...this.state.stream, tokens: (this.state.stream.tokens || 0) + (payload.deltaTokens || 0) };
        }
        break;
      case 'stream_stop':
        this.state.stream = null;
        break;

    }
    this.emit();
  }

  reset() {
    this.state.entries = [];
    this.state.currentAssistant = null;
    this.state.usage = null;
    this.state.error = null;
    this.emit();
  }
}

let singleton = null;
export function getStore() {
  if (!singleton) singleton = new Store();
  return singleton;
}
