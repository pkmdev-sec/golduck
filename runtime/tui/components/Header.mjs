/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI / Header — droidx splash header
 * ─────────────────────────────────────────────────────────────────────────
 * Visually matches the droidx launch screen:
 *
 *              ██████   ██████    ██████   ██   ██████
 *              ██   ██  ██   ██  ██    ██  ██   ██   ██
 *              ██   ██  ██████   ██    ██  ██   ██   ██
 *              ██████   ██   ██   ██████   ██   ██████
 *
 *                               v0.1.0
 *
 *             You are standing in an open terminal.
 *                 An AI awaits your commands.
 *
 *         ENTER to send · \ + ENTER for a new line · @ to mention files
 *                 Current folder: /path/to/cwd
 *
 * The component is intentionally render-once (no animation, no border) so
 * it feels identical to droidx's calm splash. A horizontal rule is NOT
 * drawn — droidx keeps the whitespace clean.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, SPLASH } from '../theme.mjs';

const h = React.createElement;

// ASCII block-art spelling "DROID". Each row is 52 cells wide. Rendered in
// primary orange to match the droidx splash.
const DROID_LINES = [
  ' ██████   ██████   ██      ██████   ██    ██   ██████  ██   ██',
  '██       ██    ██  ██      ██   ██  ██    ██  ██       ██  ██ ',
  '██  ███  ██    ██  ██      ██   ██  ██    ██  ██       █████  ',
  '██   ██  ██    ██  ██      ██   ██  ██    ██  ██       ██  ██ ',
  ' ██████   ██████   ██████  ██████    ██████    ██████  ██   ██',
];

// Short slug rendered under the DROID blocks (matches "v0.57.2" in droidx).
function readVersion() {
  try {
    const v = process.env.GOLDUCK_VERSION;
    if (v) return `v${v.replace(/^v/, '')}`;
  } catch {}
  return 'v0.1.0';
}

// True printable width (handles combining/zero-width chars well enough for
// our ASCII art).
function widthOf(s) { return Array.from(String(s)).length; }

function centerPad(text, cols) {
  const w = widthOf(text);
  if (w >= cols) return 0;
  return Math.floor((cols - w) / 2);
}

function abbreviate(path) {
  if (!path) return '';
  const home = process.env.HOME || '';
  return home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

export function Header({ banner }) {
  // Defer to WelcomeCell for the landing splash. Once the user has sent
  // anything we fall back to a compact top-bar so the rest of the chat
  // isn't pushed off-screen.
  if (banner?._compact === false) return h(Box, null);

  // Compact top-bar: renders only a thin row so the history area is roomy.
  const cwd = abbreviate(process.cwd());
  const branch = banner?.branch || null;
  const cols = Math.max(
    40,
    process.stdout.columns || parseInt(process.env.COLUMNS || '100', 10),
  );

  // Model / tier summary.
  const model = banner?.model || 'claude-opus-4-7';
  const tier = banner?.tier || 'opus';

  const left = h(Text, null,
    h(Text, { color: COLORS.primary, bold: true }, 'GOLDUCK'),
    h(Text, { color: COLORS.textMuted }, ' · '),
    h(Text, { color: COLORS.textSecondary, bold: true }, model),
    h(Text, { color: COLORS.textMuted }, ' · '),
    h(Text, { color: COLORS.textMuted }, tier),
  );
  const rightPlain = cwd + (branch ? `  › ${branch}` : '');
  const leftPlainWidth = widthOf(`GOLDUCK · ${model} · ${tier}`);
  const pad = Math.max(2, cols - leftPlainWidth - widthOf(rightPlain) - 2);

  return h(Box, { flexDirection: 'column' },
    h(Box, { paddingX: 1 },
      left,
      h(Text, null, ' '.repeat(pad)),
      h(Text, { color: COLORS.textMuted }, rightPlain),
    ),
  );
}

// Full splash renderer — reused by WelcomeCell.
export function Splash() {
  // Cap centering to a narrow viewport so the splash sits in a readable
  // left-of-center column regardless of how wide the terminal claims to
  // be. IDE-embedded terminals often report 200+ cols; matching that
  // would push the splash far-right. 96 cols matches droidx's launch.
  const rawCols =
    process.stdout.columns || parseInt(process.env.COLUMNS || '100', 10);
  const cols = Math.min(Math.max(40, rawCols), 96);
  const blockLeftPad = centerPad(DROID_LINES[0], cols);
  const version = readVersion();
  const tagPad   = centerPad(SPLASH.tagline, cols);
  const hintPad  = centerPad(SPLASH.hint, cols);
  const cwdLine  = `Current folder: ${abbreviate(process.cwd())}`;
  const cwdPad   = centerPad(cwdLine, cols);
  const verPad   = centerPad(version, cols);

  const children = [];
  children.push(h(Box, { key: 'sp-top' }, h(Text, null, ' ')));
  for (let i = 0; i < DROID_LINES.length; i++) {
    children.push(
      h(Box, { key: `dl-${i}` },
        h(Text, null, ' '.repeat(blockLeftPad)),
        h(Text, { color: COLORS.primary, bold: true }, DROID_LINES[i]),
      ),
    );
  }
  children.push(h(Box, { key: 'sp-ver-pad' }, h(Text, null, ' ')));
  children.push(h(Box, { key: 'sp-ver' },
    h(Text, null, ' '.repeat(verPad)),
    h(Text, { color: COLORS.textMuted, italic: true }, version),
  ));
  children.push(h(Box, { key: 'sp-mid' }, h(Text, null, ' ')));
  children.push(h(Box, { key: 'sp-tag' },
    h(Text, null, ' '.repeat(tagPad)),
    h(Text, { color: COLORS.textSecondary, italic: true }, SPLASH.tagline),
  ));
  children.push(h(Box, { key: 'sp-tagpad' }, h(Text, null, ' ')));
  children.push(h(Box, { key: 'sp-hint' },
    h(Text, null, ' '.repeat(hintPad)),
    h(Text, { color: COLORS.textMuted }, SPLASH.hint),
  ));
  children.push(h(Box, { key: 'sp-hintpad' }, h(Text, null, ' ')));
  children.push(h(Box, { key: 'sp-cwd' },
    h(Text, null, ' '.repeat(cwdPad)),
    h(Text, { color: COLORS.textMuted }, cwdLine),
  ));

  return h(Box, { flexDirection: 'column', paddingY: 0 }, ...children);
}
