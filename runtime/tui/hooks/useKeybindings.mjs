/* ─────────────────────────────────────────────────────────────────────────
 * useKeybindings — every top-level key passes through this hook.
 * ─────────────────────────────────────────────────────────────────────────
 * Called from App.mjs. Guarded with `{ isActive: Boolean(hasTTY) }` because
 * ink's useInput crashes on non-raw stdin.
 *
 * Bindings:
 *   ^C         first press → interrupt banner; second press (within 3s) → exit
 *   ^D         hard exit
 *   ^T         /trace
 *   ^M         /memory
 *   ^K         /skills
 *   ^O         /tools
 *   ^H         /help
 *   ^S         /stats
 *   ^R         /sessions
 *   ^P         /plan
 *   ^L         clear history
 *   esc        close overlay OR cancel in-flight
 *
 * Slash-palette-specific bindings (like ↑↓⏎) live inside Commands.mjs to
 * keep concerns local.
 * ───────────────────────────────────────────────────────────────────────── */
import { useInput } from 'ink';

export function useKeybindings({
  hasTTY, isOverlay, interrupted, setInterrupted, exitApp,
  onOpenHelp, onOpenMemory, onOpenSkills, onOpenTrace, onOpenStats, onOpenSessions,
  onOpenTools, onOpenCommands, onOpenPlan, onOpenDiff, onOpenBundle, onOpenMcp, onOpenReflect, onOpenDoctor,
  onOpenAgents, onOpenMetrics, onOpenReverseHistory, onOpenWorkspace,
  onCancel, onClearHistory,
}) {
  useInput((ch, key) => {
    // Global: ^C / ^D.
    if (key.ctrl && (ch === 'c' || ch === 'C')) {
      if (interrupted) { exitApp?.(); process.exit(130); }
      setInterrupted?.(true);
      setTimeout(() => setInterrupted?.(false), 3000);
      return;
    }
    if (key.ctrl && (ch === 'd' || ch === 'D')) { exitApp?.(); return; }

    // Inside an overlay: only esc + cancellation routed here; sub-component
    // handles ↑↓⏎ etc.
    if (isOverlay) {
      if (key.escape) { onCancel?.(); return; }
      return;
    }

    // Top-level overlay shortcuts.
    if (key.ctrl && ch === 't') onOpenTrace?.();
    else if (key.ctrl && ch === 'm') onOpenMemory?.();
    else if (key.ctrl && ch === 'k') onOpenSkills?.();
    else if (key.ctrl && ch === 'o') onOpenTools?.();
    else if (key.ctrl && ch === 'h') onOpenHelp?.();
    else if (key.ctrl && ch === 's') onOpenStats?.();
    else if (key.ctrl && ch === 'r') onOpenReverseHistory?.();
    else if (key.ctrl && ch === 'q') onOpenSessions?.();
    else if (key.ctrl && ch === 'p') onOpenPlan?.();
    else if (key.ctrl && ch === 'g') onOpenDiff?.();      // 'g' for git diff
    else if (key.ctrl && ch === 'b') onOpenBundle?.();   // 'b' for bundle
    else if (key.ctrl && ch === 'y') onOpenMcp?.();      // 'y' for mcp
    else if (key.ctrl && ch === 'f') onOpenReflect?.();  // 'f' for reflect/lessons
    else if (key.ctrl && ch === 'v') onOpenDoctor?.();   // 'v' for verify-health
    else if (key.ctrl && ch === 'a') onOpenAgents?.();   // 'a' for agents
    else if (key.ctrl && ch === 'x') onOpenMetrics?.();
    else if (key.ctrl && ch === 'w') onOpenWorkspace?.();  // 'x' for (e)xtended metrics
    // Page / scroll keys intentionally unbound: terminal-native scrollback
    // (Cmd+↑, mouse wheel, Shift+PgUp in the host terminal) handles history
    // navigation. ^Y / 'e' no longer have meanings because there's no
    // focused cell to copy or expand.
    else if (key.ctrl && ch === 'l') onClearHistory?.();
    else if (key.escape) onCancel?.();
  }, { isActive: Boolean(hasTTY) });
}
