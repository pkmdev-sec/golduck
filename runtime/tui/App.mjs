/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI / App.mjs — top-level ink React component
 * ─────────────────────────────────────────────────────────────────────────
 * This is the orchestrator. It:
 *   1. Subscribes to the event store and re-renders on every push().
 *   2. Owns the transient UI state the store does not:
 *        overlay (null | 'help' | 'memory' | …)
 *        toast   ({ message, kind }  short-lived footer flash)
 *        tick    (animated spinner counter)
 *        composer input buffer
 *   3. Routes cells → components (UserCell, AssistantCell, ToolCell, …).
 *   4. Centralizes keybindings via useKeybindings.
 *   5. Dispatches slash commands via commands.mjs (before the engine sees
 *      them). Commands either open overlays, mutate the store, or rewrite
 *      the text into an engine injection.
 *   6. Auto-opens the /commands palette when the composer starts with `/`.
 *
 * Layout:
 *   ┌ Header ───────────────────────────────────────────────────────┐
 *   │ Scrollable history (last N cells)                             │
 *   │ (overlay panel — when open — renders BELOW history, not over) │
 *   │ Composer                                                      │
 *   └ StatusLine ───────────────────────────────────────────────────┘
 * ───────────────────────────────────────────────────────────────────────── */

import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useApp } from 'ink';

import { Header }         from './components/Header.mjs';
import { UserCell }       from './components/UserCell.mjs';
import { AssistantCell }  from './components/AssistantCell.mjs';
import { MarkdownCell }   from './components/MarkdownCell.mjs';
import { ToolCell }       from './components/ToolCell.mjs';
import { ThinkingCell }   from './components/ThinkingCell.mjs';
import { VerifyCell }     from './components/VerifyCell.mjs';
import { HandoffCell }    from './components/HandoffCell.mjs';
import { CompactCell }    from './components/CompactCell.mjs';
import { RecallCell }     from './components/RecallCell.mjs';
import { ErrorCell }      from './components/ErrorCell.mjs';
import { PlanCell }       from './components/PlanCell.mjs';
import { RetryCell }      from './components/RetryCell.mjs';
import { ToolChain }      from './components/ToolChain.mjs';
import { Toast }          from './components/Toast.mjs';
import { WelcomeCell }    from './components/WelcomeCell.mjs';
import { StreamingBar }   from './components/StreamingBar.mjs';
import { StatusLine, ModeLine } from './components/StatusLine.mjs';
import { Composer }       from './components/Composer.mjs';

import { Help }           from './overlays/Help.mjs';
import { Memory }         from './overlays/Memory.mjs';
import { Skills }         from './overlays/Skills.mjs';
import { Tools }          from './overlays/Tools.mjs';
import { Trace }          from './overlays/Trace.mjs';
import { Stats }          from './overlays/Stats.mjs';
import { Sessions }       from './overlays/Sessions.mjs';
import { Plan }           from './overlays/Plan.mjs';
import { Diff }           from './overlays/Diff.mjs';
import { Commands }       from './overlays/Commands.mjs';
import { MentionPicker }  from './overlays/MentionPicker.mjs';
import { parseMention }   from './mention_scanner.mjs';
import { Bundle }         from './overlays/Bundle.mjs';
import { Mcp }            from './overlays/Mcp.mjs';
import { Reflect }        from './overlays/Reflect.mjs';
import { Doctor }         from './overlays/Doctor.mjs';
import { Agents }         from './overlays/Agents.mjs';
import { Metrics }        from './overlays/Metrics.mjs';
import { ReverseHistory } from './overlays/ReverseHistory.mjs';
import { Persona }        from './overlays/Persona.mjs';
import { Bench }          from './overlays/Bench.mjs';
import { Spend }          from './overlays/Spend.mjs';
import { Dag }            from './overlays/Dag.mjs';
import { Workspace }      from './overlays/Workspace.mjs';

import { getStore }       from './store.mjs';
import { useKeybindings } from './hooks/useKeybindings.mjs';
import { dispatchSlash, parseSlash } from './commands.mjs';
import { cancelCurrentTurn } from './engine_tui.mjs';
import { detectResumeCandidate, formatResumeSuggestion } from './resume_detect.mjs';

const h = React.createElement;

const MD_CAPABLE_ASSISTANT = String(process.env.GOLDUCK_TUI_MARKDOWN ?? '1') !== '0';

/** Thin wrapper around mention_scanner.parseMention — returns the partial query
 *  (regardless of kind) to drive the overlay auto-open effect. null if no mention. */
function extractAtQuery(input) {
  const m = parseMention(input);
  return m ? m.query : null;
}


/** computeLiveCut — returns the index (in state.entries) where the live tail
 *  begins. Everything before this index is immutable and safe to bake into
 *  Ink's <Static> so it flows into the terminal's scrollback and never
 *  repaints. The live tail keeps rendering every tick.
 *
 *  Live tail includes:
 *    - any tool cell still `running` (it mutates on tool_done)
 *    - the last assistant cell IFF state.stream is active (it mutates on
 *      every assistant_text delta)
 *    - everything after those anchors
 *
 *  If nothing is live, we still keep the final entry in the live slot so
 *  the common "one-shot reply" case doesn't freeze a cell that might still
 *  receive a trailing `usage` update.
 */
export function computeLiveCut(state) {
  const entries = state.entries || [];
  if (entries.length === 0) return 0;
  let cut = entries.length; // default: nothing is live → all frozen
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === 'tool' && e.status === 'running') cut = i;
    else if (e.kind === 'assistant' && state.stream) cut = i;
  }
  // When a stream just ended but the very last entry is an assistant, keep
  // it live for one more tick so a trailing usage update renders without
  // tearing (it will freeze on the next cut recompute once assistant_text
  // stops).
  if (cut === entries.length && state.stream) cut = Math.max(0, entries.length - 1);
  return cut;
}

function Entry({ entry, streaming, tick }) {
  // Every entry renders inline without a focus marker. Native terminal
  // scrollback replaces the old in-app scroll model so there's no focused
  // cell to decorate.
  return renderCell(entry, { streaming, tick });
}

function renderCell(entry, { streaming = false, tick = 0 } = {}) {
  switch (entry.kind) {
    case 'user':      return h(UserCell,      { text: entry.text });
    case 'assistant': return MD_CAPABLE_ASSISTANT
      ? h(MarkdownCell, { entry, streaming, tick })
      : h(AssistantCell, { entry });
    case 'tool':      return h(ToolCell,      { entry });
    case 'thinking':  return h(ThinkingCell,  { entry });
    case 'verify':    return h(VerifyCell,    { entry });
    case 'handoff':   return h(HandoffCell,   { entry });
    case 'compact':   return h(CompactCell,   { entry });
    case 'recall':    return h(RecallCell,    { entry });
    case 'error':     return h(ErrorCell,     { entry });
    case 'plan':      return h(PlanCell,      { entry, tick });
    case 'retry':     return h(RetryCell,     { entry });
    default:          return null;
  }
}

function Overlay({ name, store, state, hasTTY, composerValue, onClose, onInvoke, onChooseCommand, onChooseHistory, onChooseMention }) {
  switch (name) {
    case 'help':     return h(Help,     { onClose, hasTTY });
    case 'memory':   return h(Memory,   { onClose, hasTTY });
    case 'skills':   return h(Skills,   { onClose, hasTTY, onInvoke });
    case 'tools':    return h(Tools,    { tools: state.toolCatalog || [], onClose, hasTTY });
    case 'trace':    return h(Trace,    { onClose, hasTTY });
    case 'stats':    return h(Stats,    { onClose, hasTTY });
    case 'sessions': return h(Sessions, { onClose, hasTTY, onInvoke });
    case 'plan':     return h(Plan,     { onClose, hasTTY });
    case 'diff':     return h(Diff,     { onClose, hasTTY });
    case 'bundle':   return h(Bundle,   { onClose, hasTTY });
    case 'mcp':      return h(Mcp,      { onClose, hasTTY });
    case 'reflect':  return h(Reflect,  { onClose, hasTTY });
    case 'doctor':   return h(Doctor,   { onClose, hasTTY });
    case 'agents':   return h(Agents,   { onClose, hasTTY });
    case 'metrics':  return h(Metrics,  { onClose, hasTTY });
    case 'persona':  return h(Persona,  { onClose, hasTTY });
    case 'bench':    return h(Bench,    { onClose, hasTTY });
    case 'spend':    return h(Spend,    { onClose, hasTTY });
    case 'dag':      return h(Dag,      { onClose, hasTTY });
    case 'workspace':return h(Workspace,{ onClose, hasTTY });
    case 'rev':      return h(ReverseHistory, {
      entries: state.entries, query: composerValue || '',
      onChoose: onChooseHistory,
      onClose, hasTTY,
    });
    case 'mention':  {
      return h(MentionPicker, {
        input: composerValue || '', hasTTY,
        onClose,
        onChoose: (it) => { onChooseMention?.(it); },
      });
    }
    case 'commands': return h(Commands, {
      query: composerValue || '/',
      onClose,
      onChoose: onChooseCommand,
      hasTTY,
    });
    default:         return null;
  }
}

export function App({ onSubmit }) {
  const store = getStore();
  const [state, setState] = useState(store.state);
  const [input, setInput] = useState('');
  const [overlay, setOverlay] = useState(null);
  const [toast, setToast] = useState(null);
  const [interrupted, setInterrupted] = useState(false);
  const [tick, setTick] = useState(0);
  const [welcome, setWelcome] = useState(() => {
    try {
      const cand = detectResumeCandidate({ home: process.env.GOLDUCK_HOME });
      return { shown: true, resumeTip: formatResumeSuggestion(cand), candidate: cand };
    } catch { return { shown: true, resumeTip: null, candidate: null }; }
  });
  const app = useApp();
  const hasTTY = Boolean(process.stdin.isTTY);

  // Subscribe to store updates.
  useEffect(() => store.subscribe(setState), [store]);

  // Animate spinner only while actually busy/streaming. Slowed to 250ms
  // to reduce flicker in embedded terminals; still fast enough to read
  // as a spinner. No animation when idle — keeps the UI completely quiet.
  useEffect(() => {
    if (!state.busy && !state.stream) return;
    const id = setInterval(() => setTick((t) => (t + 1) % 10_000), 250);
    return () => clearInterval(id);
  }, [state.busy, state.stream]);

  // No cursor-blink timer; no per-second nowTick. Both were pure flicker
  // sources — the session uptime updates on every real event, which is
  // accurate enough.
  const blink = true;

  // Auto-show store-emitted notices as toasts.
  useEffect(() => {
    if (state.notice && (!toast || toast.id !== state.notice.id)) {
      setToast(state.notice);
    }
  }, [state.notice, toast]);

  // Auto-clear toast after 2.5s.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // Auto-open / auto-close the /commands palette or @mention picker.
  useEffect(() => {
    const isSlash = input.startsWith('/');
    const atQuery = extractAtQuery(input);
    const inStaticOverlay = ['help','memory','skills','tools','trace','stats','sessions','plan','diff','bundle','mcp','reflect','doctor','agents','metrics','persona','bench','rev','spend','dag','workspace'].includes(overlay);
    if (isSlash && overlay !== 'commands' && !inStaticOverlay) {
      setOverlay('commands');
    } else if (atQuery != null && !isSlash && overlay !== 'mention' && !inStaticOverlay) {
      setOverlay('mention');
    } else if (!isSlash && atQuery == null && (overlay === 'commands' || overlay === 'mention')) {
      setOverlay(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  const closeOverlay = () => setOverlay(null);

  const submitEngine = (text) => {
    onSubmit && onSubmit(text);
  };

  const runSlashLine = (line) => {
    const res = dispatchSlash({
      line,
      store,
      setOverlay,
      setToast: (t) => setToast({ ...t, id: `toast-${Date.now()}-${Math.random()}` }),
      submitEngine,
    });
    if (res?.toast) setToast({ ...res.toast, id: `toast-${Date.now()}-${Math.random()}` });
    if (res?.injection) submitEngine(res.injection);
    return res;
  };

  const handleSubmit = (value) => {
    const v = (value ?? '').trim();
    if (!v) return;
    setInput('');
    // Slash command path.
    if (v.startsWith('/')) { runSlashLine(v); return; }
    submitEngine(v);
  };

  const handleChooseCommand = (c) => {
    setInput(c.name + ' ');
    // If the command takes no args (opens overlay / pure side-effect), fire now.
    const argless = new Set([
      '/help','/commands','/memory','/skills','/tools','/trace','/stats','/sessions','/plan','/diff','/bundle','/mcp','/reflect','/doctor','/agents','/metrics','/persona','/bench','/rev','/spend','/dag','/workspace',
      '/reset','/clear','/compact','/save','/tokens','/cost','/verify','/busy','/exit','/quit',
    ]);
    if (argless.has(c.name)) { setInput(''); runSlashLine(c.name); }
  };

  const handleCancel = () => {
    if (overlay) { setOverlay(null); return; }
    if (state.busy) {
      cancelCurrentTurn('esc');
      setToast({ message: 'cancelling…', kind: 'warn', id: `toast-${Date.now()}` });
    }
  };

  const handleClearHistory = () => { store.reset(); setToast({ message: 'history cleared', kind: 'ok', id: `toast-${Date.now()}` }); };

  useKeybindings({
    hasTTY,
    isOverlay: Boolean(overlay),
    interrupted,
    setInterrupted,
    exitApp: () => app.exit(),
    onOpenHelp:     () => setOverlay('help'),
    onOpenMemory:   () => setOverlay('memory'),
    onOpenSkills:   () => setOverlay('skills'),
    onOpenTrace:    () => setOverlay('trace'),
    onOpenStats:    () => setOverlay('stats'),
    onOpenSessions: () => setOverlay('sessions'),
    onOpenTools:    () => setOverlay('tools'),
    onOpenCommands: () => setOverlay('commands'),
    onOpenPlan:     () => setOverlay('plan'),
    onOpenDiff:     () => setOverlay('diff'),
    onOpenBundle:   () => setOverlay('bundle'),
    onOpenMcp:      () => setOverlay('mcp'),
    onOpenReflect:  () => setOverlay('reflect'),
    onOpenDoctor:   () => setOverlay('doctor'),
    onOpenAgents:   () => setOverlay('agents'),
    onOpenMetrics:  () => setOverlay('metrics'),
    onOpenReverseHistory: () => setOverlay('rev'),
    onOpenWorkspace: () => setOverlay('workspace'),
    onCancel:       handleCancel,
    onClearHistory: handleClearHistory,
  });

  // Hide welcome after the user sends anything.
  useEffect(() => {
    if (welcome.shown && state.entries.some((e) => e.kind === 'user')) {
      setWelcome((w) => ({ ...w, shown: false }));
    }
  }, [state.entries, welcome.shown]);

  // Render every entry. Terminal-native scrollback (Cmd+↑, mouse wheel,
  // PgUp in the real terminal) handles history navigation — no in-app
  // viewport window, no focus pointer. Long responses stay visible in the
  // scrollback buffer after the session ends.
  // Split entries into "frozen" (already done — goes into <Static> so the
  // terminal's native scrollback owns them forever) and "live" (currently
  // mutating: the streaming assistant tail + any running tool). Ink's <Static>
  // only renders each item once; committing completed turns to scrollback is
  // what makes long responses scrollable in the first place.
  const visible = state.entries;
  const visibleStart = 0;
  const liveCut = computeLiveCut(state);
  const frozenEntries = liveCut > 0 ? state.entries.slice(0, liveCut) : [];
  const liveEntries   = liveCut > 0 ? state.entries.slice(liveCut)   : state.entries;

  const slashPreview = input.startsWith('/') ? '⏎ run · esc cancel' : null;

  return h(Box, { flexDirection: 'column' },
    // Splash (WelcomeCell) is the droidx-style centered header until the
    // first user message; after that we switch to a compact one-line
    // DROID top-bar so the conversation stays visible.
    !welcome.shown && h(Header, { banner: state.banner }),

    // History body.
    h(Box, { flexDirection: 'column' },
      welcome.shown && h(WelcomeCell, {
        banner: state.banner,
        toolCount: state.toolCatalog?.length || state.banner?.toolCount || 0,
        hasPriorSession: Boolean(welcome.candidate && welcome.candidate.message_count >= 2),
        resumeTip: welcome.resumeTip || null,
      }),
      // Frozen history: <Static> renders each item EXACTLY ONCE and commits
      // those lines to the terminal's scrollback. They never repaint, which is
      // what makes native scrollback work for long assistant responses.
      frozenEntries.length > 0 && h(Static, { items: frozenEntries },
        (e) => h(Entry, { key: e.id, entry: e, streaming: false, tick: 0 }),
      ),
      // Live tail: the currently-streaming assistant + any still-running tool
      // calls + recent pending cells. Grouped + re-rendered every tick.
      ...(() => {
        const nodes = [];
        let i = 0;
        while (i < liveEntries.length) {
          const e = liveEntries[i];
          if (e.kind === 'tool') {
            let j = i;
            while (j < liveEntries.length && liveEntries[j].kind === 'tool') j++;
            const group = liveEntries.slice(i, j);
            if (group.length >= 2) {
              nodes.push(h(ToolChain, { key: `chain-${group[0].id}`, entries: group, tick }));
              i = j;
              continue;
            }
          }
          const isLastAssistant = state.stream && e.kind === 'assistant' &&
            !liveEntries.slice(i + 1).some((x) => x.kind === 'assistant');
          nodes.push(h(Entry, {
            key: e.id, entry: e,
            streaming: Boolean(isLastAssistant),
            tick,
          }));
          i++;
        }
        return nodes;
      })(),
    ),

    // Overlay (rendered inline under the history, above the composer).
    // No decorative divider — overlays have their own border chrome.
    overlay && h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Overlay, {
        name: overlay, store, state, hasTTY,
        composerValue: input,
        onClose: closeOverlay,
        onInvoke: (text) => { closeOverlay(); runSlashLine(text); },
        onChooseCommand: handleChooseCommand,
        onChooseHistory: (text) => { setInput(text); closeOverlay(); },
        onChooseMention: (it) => {
          if (typeof it?.insertAt === 'number' && typeof it?.replaceLength === 'number') {
            const before = input.slice(0, it.insertAt);
            const after  = input.slice(it.insertAt + it.replaceLength);
            setInput(before + it.path + ' ' + after);
          } else if (it?.path) {
            const at = input.lastIndexOf('@');
            setInput((at >= 0 ? input.slice(0, at) : input) + it.path + ' ');
          }
          closeOverlay();
        },
      }),
    ),

    // Transient toast (single line flash).
    toast && h(Toast, { message: toast.message, kind: toast.kind, onDismiss: () => setToast(null) }),

    // Streaming progress (renders only while the assistant is streaming).
    state.stream && h(StreamingBar, {
      visible: true,
      elapsedMs: Date.now() - state.stream.startedAt,
      tokens: state.stream.tokens || 0,
      label: 'streaming',
    }),

    // Mode block (autonomy + model) above the composer — droidx parity.
    h(ModeLine, { statusLine: state.statusLine }),

    // Composer + status line always pinned to the bottom.
    h(Composer, {
      value: input,
      onChange: setInput,
      onSubmit: handleSubmit,
      hint: state.busy
        ? ''   // StatusLine already shows the busy label; no need to echo it.
        : 'Ask anything · / for commands · @ for files',
      dim: state.busy,
      slashHint: slashPreview,
      blink,
    }),
    h(StatusLine, {
      statusLine: state.statusLine,
      interrupted,
      busy: state.busy,
      busyLabel: state.busyLabel,
      tick,
      sessionStart: state.sessionStart,
      msgCount: state.entries.filter((e) => e.kind === 'user').length,
    }),
  );
}
