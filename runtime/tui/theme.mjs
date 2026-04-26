/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI theme — droidx visual parity palette
 * ─────────────────────────────────────────────────────────────────────────
 * This file is authoritative for every color and glyph the TUI paints. The
 * palette is an exact port of the droidx theme so a side-by-side session
 * (`golduck` vs `droidx`) is visually indistinguishable.
 *
 *   primary   #d56a26   (brand orange; "> " prompt, mode chip, cursor)
 *   border    #888888   (panel borders, dividers)
 *   success   green     (verify approve, tool ok)
 *   error     #ef4444   (abort, fail)
 *   warning   #fbbf24   (soft-warn)
 *   spec      #b5b1fc   (spec mode accents)
 *   text.primary  #f2f0f0
 *   text.secondary #b3a9a4
 *   text.muted #80756f
 *   text.user  #EBB28C
 *
 * Exports the COLORS record + structured GLYPH + HOTKEYS used by the
 * status line. Light / classic fall-backs live below but the default
 * "dark" theme is the droidx reference.
 * ───────────────────────────────────────────────────────────────────────── */

// droidx reference palette. All hex values taken verbatim from the droidx
// build string table.
const DROIDX = {
  // Flat role → color (ink-compatible hex).
  primary:   '#d56a26',
  border:    '#888888',
  success:   '#22c55e',
  error:     '#ef4444',
  warning:   '#fbbf24',
  spec:      '#b5b1fc',

  // Role aliases used by existing components. The left keys stay so we
  // don't have to touch every cell, but the right values now match droidx.
  brand:     '#d56a26',
  brandDim:  '#b25a1f',
  user:      '#EBB28C',
  assistant: '#f2f0f0',
  tool:      '#b3a9a4',
  ok:        '#22c55e',
  warn:      '#fbbf24',
  thinking:  '#80756f',
  dim:       '#80756f',

  // Typographic tiers.
  textPrimary:   '#f2f0f0',
  textSecondary: '#b3a9a4',
  textMuted:     '#80756f',
  textUser:      '#EBB28C',
};

// Light fallback (for `GOLDUCK_THEME=light`). Mirrors droidx's light palette.
const LIGHT = {
  primary:   '#F27B2F',
  border:    '#9B8E87',
  success:   '#5B8E63',
  error:     '#E54048',
  warning:   '#F0A330',
  spec:      '#157AC6',
  brand:     '#F27B2F',
  brandDim:  '#BC4B00',
  user:      '#BC4B00',
  assistant: '#1D1B1A',
  tool:      '#59514D',
  ok:        '#5B8E63',
  warn:      '#F0A330',
  thinking:  '#665C58',
  dim:       '#665C58',
  textPrimary:   '#000000',
  textSecondary: '#59514D',
  textMuted:     '#665C58',
  textUser:      '#BC4B00',
};

// Classic fallback — fully 16-color-safe so tmux/screen/weak terminals stay
// readable. Kept for compatibility; not used by default.
const CLASSIC = {
  primary:   'yellow',
  border:    'gray',
  success:   'green',
  error:     'red',
  warning:   'yellow',
  spec:      'magenta',
  brand:     'yellow',
  brandDim:  'gray',
  user:      'yellow',
  assistant: 'white',
  tool:      'white',
  ok:        'green',
  warn:      'yellow',
  thinking:  'gray',
  dim:       'gray',
  textPrimary:   'white',
  textSecondary: 'white',
  textMuted:     'gray',
  textUser:      'yellow',
};

const THEMES = { dark: DROIDX, droidx: DROIDX, light: LIGHT, classic: CLASSIC };

function resolveTheme() {
  const name = (process.env.GOLDUCK_THEME || 'droidx').toLowerCase();
  return THEMES[name] || DROIDX;
}

export const COLORS = resolveTheme();

// Glyph inventory. Spinner matches droidx's 10-frame braille cycle.
export const GLYPH = {
  dot:      '●',
  bullet:   '•',
  arrow:    '▸',
  playhead: '▶',
  check:    '✓',
  cross:    '✗',
  square:   '■',
  diamond:  '◇',
  bar:      '│',
  divider:  '─',
  chevron:  '›',
  spinner:  ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'],
  ellipsis: '…',
};

// Hotkey chips shown in the status line. Kept short so more fit on narrow
// terminals. droidx's own footer uses plain grey text rather than chips but
// we expose both visuals; StatusLine.mjs picks the droidx-style rendering.
export const HOTKEYS = [
  { key: '⏎',  label: 'send' },
  { key: '/',  label: 'cmd' },
  { key: '^T', label: 'trace' },
  { key: '^M', label: 'memory' },
  { key: '^O', label: 'tools' },
  { key: '^P', label: 'plan' },
  { key: '^H', label: 'help' },
  { key: '^C', label: 'quit' },
];

// droidx splash tagline / hint — surfaced by Header + WelcomeCell.
export const SPLASH = {
  tagline: 'You are standing in an open terminal. An AI awaits your commands.',
  hint:    'ENTER to send · \\ + ENTER for a new line · @ to mention files',
};
