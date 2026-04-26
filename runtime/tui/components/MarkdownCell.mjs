import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![A-Za-z0-9])_[^_\n ]+_(?![A-Za-z0-9])|(?<![A-Za-z0-9])\*[^*\n ]+\*(?![A-Za-z0-9]))/g;

function renderInline(str) {
  const parts = [];
  let lastIndex = 0;
  let key = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(str)) !== null) {
    if (m.index > lastIndex) {
      parts.push(h(Text, { key: `t${key++}` }, str.slice(lastIndex, m.index)));
    }
    const tok = m[0];
    if (tok.startsWith('`')) {
      parts.push(h(Text, { key: `t${key++}`, color: 'cyan' }, tok.slice(1, -1)));
    } else if (tok.startsWith('**')) {
      parts.push(h(Text, { key: `t${key++}`, bold: true }, tok.slice(2, -2)));
    } else if (tok.startsWith('_') || tok.startsWith('*')) {
      parts.push(h(Text, { key: `t${key++}`, italic: true }, tok.slice(1, -1)));
    }
    lastIndex = m.index + tok.length;
  }
  if (lastIndex < str.length) {
    parts.push(h(Text, { key: `t${key++}` }, str.slice(lastIndex)));
  }
  return parts;
}

function renderBlock(block, idx) {
  const lines = block.split('\n');

  // Fenced code block: no heavy box, just a dim left gutter + tiny
  // language chip at the top. Cheaper visually and matches codex-style.
  if (lines[0].startsWith('```')) {
    const lang = lines[0].slice(3).trim() || 'code';
    const end = lines[lines.length - 1].startsWith('```') ? lines.length - 1 : lines.length;
    const bodyLines = lines.slice(1, end);
    return h(Box, { key: `b${idx}`, flexDirection: 'column' },
      h(Box, null,
        h(Text, { dimColor: true }, '\u2502 '),
        h(Text, { dimColor: true, italic: true }, lang),
      ),
      ...bodyLines.map((bl, j) => h(Box, { key: j },
        h(Text, { dimColor: true }, '\u2502 '),
        h(Text, { color: 'cyan' }, bl || ' '),
      )),
    );
  }

  // Heading.
  if (/^#{1,3}\s+/.test(lines[0]) && lines.length === 1) {
    const text = lines[0].replace(/^#{1,3}\s+/, '');
    return h(Text, {
      key: `b${idx}`,
      color: COLORS.brand,
      bold: true,
    }, text);
  }

  // Bullet list.
  if (lines.every((l) => /^[-*]\s+/.test(l))) {
    return h(Box, { key: `b${idx}`, flexDirection: 'column' },
      ...lines.map((l, i) => h(Box, { key: `li${i}` },
        h(Text, { dimColor: true }, `${GLYPH.bullet} `),
        h(Text, null, ...renderInline(l.replace(/^[-*]\s+/, ''))),
      )),
    );
  }

  // Numbered list.
  if (lines.every((l) => /^\d+\.\s+/.test(l))) {
    return h(Box, { key: `b${idx}`, flexDirection: 'column' },
      ...lines.map((l, i) => {
        const match = l.match(/^(\d+\.)\s+(.*)$/);
        const ord = match ? match[1] : '';
        const rest = match ? match[2] : l;
        return h(Box, { key: `li${i}` },
          h(Text, { dimColor: true }, `${ord} `),
          h(Text, null, ...renderInline(rest)),
        );
      }),
    );
  }

  // Blockquote.
  if (lines.every((l) => l.startsWith('> '))) {
    return h(Box, { key: `b${idx}`, flexDirection: 'column' },
      ...lines.map((l, i) => h(Box, { key: `bq${i}` },
        h(Text, { dimColor: true }, `${GLYPH.bar} `),
        h(Text, { dimColor: true }, l.replace(/^>\s+/, '')),
      )),
    );
  }

  // Paragraph with inline styling.
  return h(Text, { key: `b${idx}`, wrap: 'wrap' }, ...renderInline(block));
}

function human(n) {
  if (n == null) return '?';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

function formatUsage(u) {
  const parts = [];
  parts.push(`↑ ${human(u.input)}`);
  parts.push(`↓ ${human(u.output)}`);
  if (u.cache_read)  parts.push(`cache ${human(u.cache_read)}`);
  if (u.usd != null)    parts.push(`$${u.usd.toFixed(4)}`);
  if (u.ctx_pct != null) parts.push(`ctx ${u.ctx_pct}%`);
  return parts.join('  ·  ');
}

/**
 * Optional props: `streaming` (bool) + `tick` (counter for pulse animation).
 * When streaming, the header dot pulses and a block cursor is appended to
 * the last rendered line so the user sees liveness even between token bursts.
 */
function MarkdownCellImpl({ entry, streaming = false, tick = 0 }) {
  const text = entry.text || '';
  const usage = entry.usage;
  // Fence-aware block splitter: never split across ``` … ``` fences.
  const blocks = (() => {
    const raw = text.split('\n');
    const out = [];
    let buf = [];
    let inFence = false;
    const flush = () => {
      if (buf.length) {
        out.push(buf.join('\n'));
        buf = [];
      }
    };
    for (const line of raw) {
      if (line.startsWith('```')) {
        if (!inFence) {
          // Start of fence: new block begins here.
          flush();
          buf.push(line);
          inFence = true;
        } else {
          // End of fence: keep in current block, then close it.
          buf.push(line);
          flush();
          inFence = false;
        }
        continue;
      }
      if (!inFence && /^\s*$/.test(line)) {
        flush();
      } else {
        buf.push(line);
      }
    }
    flush();
    return out.filter((b) => b.length > 0);
  })();

  // Static header marker; no pulse animation, no inline cursor block.
  // Streaming is conveyed by the single StreamingBar above the composer,
  // which already shows tok/elapsed. Duplicating motion here causes the
  // whole body to flicker on every tick.
  const pulseGlyph = GLYPH.dot;
  const cursorBlock = null;

  // Inline layout with no outer border. A one-line label row + blocks.
  // The StreamingBar above the composer already signals streaming state.
  return h(Box, { flexDirection: 'column', marginTop: 1 },
    h(Box, null,
      h(Text, { color: COLORS.assistant, bold: true }, `${pulseGlyph} `),
      h(Text, { color: COLORS.assistant, bold: true }, 'assistant'),
    ),
    h(Box, { flexDirection: 'column' },
      ...blocks.map((b, i) => h(Box, {
        key: `blk-${i}`,
        flexDirection: 'column',
        marginBottom: i < blocks.length - 1 ? 1 : 0,
      }, renderBlock(b, i))),
      cursorBlock && h(Box, null, cursorBlock),
      usage && h(Text, { dimColor: true }, formatUsage(usage)),
    ),
  );
}


/** Memoized wrapper: only re-render when the entry reference, streaming flag,
 *  or (for spinner animation) tick value actually change. Prevents the 500-cell
 *  transcript from re-rendering every streaming token. */
export const MarkdownCell = React.memo(MarkdownCellImpl, (prev, next) => {
  if (prev.entry !== next.entry) return false;
  if (prev.streaming !== next.streaming) return false;
  // When streaming, we DO want to animate the pulse glyph via `tick`.
  // When not streaming, ignore tick entirely.
  if (next.streaming && prev.tick !== next.tick) return false;
  return true;
});
