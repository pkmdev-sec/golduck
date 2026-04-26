/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI / Composer — bottom input area (multi-line)
 * ─────────────────────────────────────────────────────────────────────────
 * Multi-line text-area bound to `value` / `onChange`. Uses ink's `useInput`
 * directly (no ink-text-input) so we can handle newlines, cursor movement,
 * bracketed paste, and editor-style shortcuts. App.mjs still owns `input`
 * state; this component only wraps it.
 *
 * Submit rules:
 *   - Blank-line-before-cursor gesture → submit (press ⏎ on a trailing blank
 *     line of a multi-line buffer).
 *   - Shift+Enter / Alt+Enter / Ctrl+J → always insert newline.
 *   - Plain ⏎ on a single-line buffer → submit.
 *   - Plain ⏎ on a multi-line buffer → insert newline.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text, useInput } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';
import { filterCommands } from '../commands.mjs';
import { loadHistory } from '../history_store.mjs';

const h = React.createElement;

// ── helpers ─────────────────────────────────────────────────────────────
function lineStartOf(str, cursor) {
  const prev = str.lastIndexOf('\n', cursor - 1);
  return prev < 0 ? 0 : prev + 1;
}
function lineEndOf(str, cursor) {
  const next = str.indexOf('\n', cursor);
  return next < 0 ? str.length : next;
}
function deletePrevWord(str, cursor) {
  if (cursor <= 0) return { next: str, cursor };
  let i = cursor;
  while (i > 0 && /\s/.test(str[i - 1])) i--;          // trailing ws
  while (i > 0 && !/\s/.test(str[i - 1])) i--;         // word chars
  return { next: str.slice(0, i) + str.slice(cursor), cursor: i };
}

export function Composer({ value, onChange, onSubmit, hint = null, dim = false, slashHint = null, blink = true }) {
  const hasTTY = Boolean(process.stdin.isTTY);
  const safeValue = typeof value === 'string' ? value : '';
  const [cursor, setCursor] = React.useState(safeValue.length);
  // Command history: load once, cycle with ↑/↓ while the composer is empty.
  const [historyIdx, setHistoryIdx] = React.useState(-1);  // -1 = not cycling
  const historyRef = React.useRef(null);
  const getHistory = () => {
    if (historyRef.current) return historyRef.current;
    try {
      historyRef.current = loadHistory({ limit: 200 })
        .map((h) => h.text).filter(Boolean).reverse();  // newest first
    } catch { historyRef.current = []; }
    return historyRef.current;
  };

  // Clamp cursor if `value` shrinks from outside (e.g. after submit → '').
  React.useEffect(() => {
    if (cursor > safeValue.length) setCursor(safeValue.length);
  }, [safeValue, cursor]);

  const commit = (next, nextCursor) => {
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    onChange?.(next);
  };

  useInput((ch, key) => {
    const v = typeof value === 'string' ? value : '';
    const c = Math.max(0, Math.min(cursor, v.length));

    // ── Control shortcuts ────────────────────────────────────────────
    // Tab: complete slash command if the composer is a lone slash prefix.
    if (ch === '\t' || key.tab) {
      if (v.startsWith('/') && !v.includes(' ')) {
        const matches = filterCommands(v);
        if (matches.length === 1) {
          const done = matches[0].name + ' ';
          commit(done, done.length);
        } else if (matches.length > 1) {
          // Find the longest common prefix among match names.
          let lcp = matches[0].name;
          for (let i = 1; i < matches.length; i++) {
            let k = 0;
            while (k < lcp.length && k < matches[i].name.length && lcp[k] === matches[i].name[k]) k++;
            lcp = lcp.slice(0, k);
            if (lcp.length === 0) break;
          }
          if (lcp.length > v.length) commit(lcp, lcp.length);
        }
        return;
      }
      // Otherwise fall through (tab = insert 4 spaces as a mild convenience).
      commit(v.slice(0, c) + '    ' + v.slice(c), c + 4);
      return;
    }
    if (key.ctrl && ch === 'j') {
      const next = v.slice(0, c) + '\n' + v.slice(c);
      commit(next, c + 1);
      return;
    }
    if (key.ctrl && ch === 'u') {
      const ls = lineStartOf(v, c);
      commit(v.slice(0, ls) + v.slice(c), ls);
      return;
    }
    if (key.ctrl && ch === 'k') {
      const le = lineEndOf(v, c);
      commit(v.slice(0, c) + v.slice(le), c);
      return;
    }
    if (key.ctrl && ch === 'w') {
      const { next, cursor: nc } = deletePrevWord(v, c);
      commit(next, nc);
      return;
    }
    if ((key.ctrl && ch === 'a') || key.home) { setCursor(lineStartOf(v, c)); return; }
    if ((key.ctrl && ch === 'e') || key.end)  { setCursor(lineEndOf(v, c)); return; }
    if (key.ctrl && ch === 'd') {
      if (v.length === 0) return;                 // app-level exit owns this
      if (c < v.length) commit(v.slice(0, c) + v.slice(c + 1), c);
      return;
    }

    // ── Arrow keys ───────────────────────────────────────────────────
    if (key.leftArrow)  { setCursor(Math.max(0, c - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(v.length, c + 1)); return; }
    if (key.upArrow || key.downArrow) {
      if (v.indexOf('\n') < 0) {
        // No newline → treat as command-history walker.
        const hist = getHistory();
        if (!hist.length) return;
        if (key.upArrow) {
          const next = Math.min(hist.length - 1, (historyIdx < 0 ? 0 : historyIdx + 1));
          setHistoryIdx(next);
          commit(hist[next] || '', (hist[next] || '').length);
        } else {
          const next = historyIdx - 1;
          if (next < 0) {
            setHistoryIdx(-1);
            commit('', 0);
          } else {
            setHistoryIdx(next);
            commit(hist[next] || '', (hist[next] || '').length);
          }
        }
        return;
      }
      const ls = lineStartOf(v, c);
      const col = c - ls;
      if (key.upArrow) {
        if (ls === 0) return;
        const prevLs = lineStartOf(v, ls - 1);
        const prevLen = (ls - 1) - prevLs;
        setCursor(prevLs + Math.min(col, prevLen));
      } else {
        const le = lineEndOf(v, c);
        if (le === v.length) return;
        const nextLs = le + 1;
        const nextLen = lineEndOf(v, nextLs) - nextLs;
        setCursor(nextLs + Math.min(col, nextLen));
      }
      return;
    }

    // ── Backspace / Delete ───────────────────────────────────────────
    if (key.backspace || key.delete) {
      if (c <= 0) return;
      commit(v.slice(0, c - 1) + v.slice(c), c - 1);
      return;
    }

    // ── Enter / Return ───────────────────────────────────────────────
    if (key.return) {
      const endsNewline = v.endsWith('\n');
      const blankBefore = c === 0 || v[c - 1] === '\n';
      if (blankBefore && v.length > 0 && !endsNewline) {
        onSubmit?.(v);
        setCursor(0);
        return;
      }
      if (key.shift || key.meta) {
        commit(v.slice(0, c) + '\n' + v.slice(c), c + 1);
        return;
      }
      if (v.includes('\n')) {
        commit(v.slice(0, c) + '\n' + v.slice(c), c + 1);
        return;
      }
      if (v.length > 0) onSubmit?.(v);
      setCursor(0);
      return;
    }

    // Any printable keystroke cancels history cycling.
    if (historyIdx >= 0 && !key.upArrow && !key.downArrow) setHistoryIdx(-1);

    // ── Printable / bracketed-paste chunks ───────────────────────────
    if (ch && !key.ctrl && !key.meta) {
      const isLoneControl =
        ch.length === 1 && ch.charCodeAt(0) < 0x20 && ch !== '\n' && ch !== '\t';
      if (isLoneControl) return;
      commit(v.slice(0, c) + ch + v.slice(c), c + ch.length);
    }
  }, { isActive: hasTTY });

  // ── Non-TTY fallback: no key handlers, just a dim preview ──────────
  if (!hasTTY) {
    const isCommand = safeValue.startsWith('/');
    return h(Box, { paddingX: 1, marginTop: 1, flexDirection: 'column' },
      h(Text, { dimColor: true },
        h(Text, { color: COLORS.brand, bold: true }, '> '),
        safeValue || hint || '',
      ),
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  const isCommand = safeValue.startsWith('/');
  const lines = safeValue.length === 0 ? [''] : safeValue.split('\n');

  // cursor → (row, col)
  let row = 0;
  let col = cursor;
  {
    let seen = 0;
    let placed = false;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length;
      if (cursor <= seen + len) { row = i; col = cursor - seen; placed = true; break; }
      seen += len + 1; // +1 for the '\n'
    }
    if (!placed) { row = lines.length; col = 0; }
  }

  const firstPrefix = '> ';
  const contPrefix  = `${GLYPH.ellipsis} `;

  // Ghost-text completion for slash commands: find the first command whose
  // name starts with what the user typed, render the rest as dim text.
  let ghost = '';
  if (isCommand) {
    const match = filterCommands(safeValue)[0];
    if (match && match.name.startsWith(safeValue)) {
      ghost = match.name.slice(safeValue.length);
    }
  }

  const renderLine = (line, idx) => {
    const isFirst = idx === 0;
    const prefixNode = isFirst
      ? h(Text, { color: COLORS.primary, bold: true }, firstPrefix)
      : h(Text, { color: COLORS.textMuted }, contPrefix);

    // Empty buffer: hint dim after prefix, cursor block at start
    if (isFirst && safeValue.length === 0) {
      const children = [prefixNode];
      if (dim) {
        if (hint) children.push(h(Text, { dimColor: true }, hint));
      } else {
        if (hint) children.push(h(Text, { dimColor: true }, hint));
        else if (blink) children.push(h(Text, { inverse: true }, ' '));
      }
      if (isCommand && slashHint) children.push(h(Text, { dimColor: true }, `  ${slashHint}`));
      return h(Box, { key: idx }, ...children);
    }

    const cursorOnThisLine = !dim && row === idx;
    const children = [prefixNode];

    if (cursorOnThisLine) {
      const before = line.slice(0, col);
      const under  = col < line.length ? line[col] : ' ';
      const after  = col < line.length ? line.slice(col + 1) : '';
      if (before) children.push(h(Text, null, before));
      if (blink) children.push(h(Text, { inverse: true }, under));
      else children.push(h(Text, null, under));
      if (after) children.push(h(Text, null, after));
      // Ghost-completion rendered dim after the cursor/remaining text.
      if (isFirst && ghost) children.push(h(Text, { dimColor: true }, ghost));
    } else {
      children.push(h(Text, dim ? { dimColor: true } : null, line || ' '));
    }

    if (isFirst && isCommand && slashHint) {
      children.push(h(Text, { dimColor: true }, `  ${slashHint}`));
    }
    return h(Box, { key: idx }, ...children);
  };

  const renderedLines = lines.map(renderLine);
  // Cursor past a trailing '\n' → render an extra blank row with the block.
  if (!dim && row === lines.length) {
    renderedLines.push(
      h(Box, { key: 'trail' },
        h(Text, { dimColor: true }, contPrefix),
        blink
          ? h(Text, { inverse: true }, ' ')
          : h(Text, null, ' '),
      ),
    );
  }

  // Mode chip: only shows for slash/mention. "prompt" is the default state
  // and needs no badge — it just clutters the header of every turn.
  const mode = isCommand ? 'slash'
    : safeValue.includes('@') ? 'mention'
    : null;
  const modeColor = mode ? COLORS.primary : undefined;

  const border = isCommand ? COLORS.primary
    : safeValue.includes('@') ? COLORS.primary
    : COLORS.border;

  return h(Box, {
    marginTop: 1,
    borderStyle: 'round',
    borderColor: border,
    paddingX: 1,
    flexDirection: 'column',
  },
    // Small mode chip only when slashing or mentioning. No "prompt" chip,
    // no char counter — keeps the composer one line taller at most, never
    // flickering.
    mode && safeValue.length >= 2 &&
      h(Box, { justifyContent: 'flex-end' },
        h(Text, { color: modeColor }, `${mode}`),
      ),
    ...renderedLines,
  );
}
