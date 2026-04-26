/* ─────────────────────────────────────────────────────────────────────────
 * golduck rich TUI renderer (runtime/ui/render.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * ANSI-only rich renderer. No extra deps. Mimics the Codex TUI aesthetic:
 *   • Bordered status box at top
 *   • Left-bar gutters for each turn type (user ▸ / assistant ● / tool ▶)
 *   • Dim metadata footer per response
 *   • Persistent bottom hint line in interactive mode
 *   • Diff-style file listings for patches
 * ───────────────────────────────────────────────────────────────────────── */

const ESC = '\x1b[';
const C = {
  dim:  s => `${ESC}2m${s}${ESC}0m`,
  bold: s => `${ESC}1m${s}${ESC}0m`,
  red:  s => `${ESC}31m${s}${ESC}0m`,
  grn:  s => `${ESC}32m${s}${ESC}0m`,
  ylw:  s => `${ESC}33m${s}${ESC}0m`,
  blu:  s => `${ESC}34m${s}${ESC}0m`,
  mag:  s => `${ESC}35m${s}${ESC}0m`,
  cyn:  s => `${ESC}36m${s}${ESC}0m`,
  und:  s => `${ESC}4m${s}${ESC}24m`,
  // tinted backgrounds for gutter indicators
  bgBlu: s => `${ESC}44m${s}${ESC}49m`,
};

// Box-drawing helpers (single-line box around N lines).
function box(lines, color = C.mag) {
  const width = Math.min(
    process.stdout.columns || 100,
    Math.max(...lines.map((l) => stripAnsi(l).length)) + 4,
  );
  const top    = color('╭' + '─'.repeat(width - 2) + '╮');
  const bottom = color('╰' + '─'.repeat(width - 2) + '╯');
  const side   = color('│');
  const mid = lines.map((l) => {
    const pad = Math.max(0, width - 2 - stripAnsi(l).length - 2);
    return `${side} ${l}${' '.repeat(pad)} ${side}`;
  });
  return [top, ...mid, bottom].join('\n');
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

// Banner — top-of-run status card. Dense + bordered.
export function renderBanner({
  runId, model, tier, thinking, verify, reflect, budget, home,
  bundleBytes, toolCount, mcpServers,
}) {
  const th = thinking ? C.cyn(`budget=${thinking.budget_tokens}`) : C.dim('off');
  const vv = verify === 'on' ? C.grn(verify) : C.dim(verify);
  const rr = reflect !== 'off' ? C.grn(reflect) : C.dim(reflect);
  const lines = [
    `${C.bold('golduck')}  ${C.dim(runId)}`,
    `${C.dim('model   ')} ${C.bold(model)}  ${C.dim('(' + tier + ')')}`,
    `${C.dim('think   ')} ${th}   ${C.dim('verify')} ${vv}   ${C.dim('reflect')} ${rr}`,
    `${C.dim('budget  ')} ${C.ylw('$' + budget)}   ${C.dim('bundle')} ${C.cyn(bundleBytes + 'B')}   ${C.dim('tools')} ${C.cyn(toolCount)}   ${C.dim('mcp')} ${C.cyn(mcpServers)}`,
  ];
  return box(lines, C.mag);
}

// User echo — left cyan bar + prompt text.
export function renderUser(text) {
  const bar = C.cyn('│ ');
  return text.split('\n').map((ln, i) => (i === 0 ? `${C.cyn('▸ ')} ` : bar) + ln).join('\n');
}

// Assistant header marker (above streaming text).
export function renderAssistantStart() {
  return `\n${C.mag('●')} ${C.bold('assistant')}`;
}

// Raw streaming text token.
export function renderAssistantText(delta) { return delta; }

// Thinking is accumulated silently, then rendered as one compact line.
export function renderThinking(delta) { return ''; }

// Tool use header (on content_block_stop so we have full input).
export function renderToolUseStart({ name, inputPreview }) {
  return `${C.cyn('▶')} ${C.bold(name)}  ${C.dim(inputPreview.slice(0, 180))}`;
}

// Tool-done outcome line.
export function renderToolDone({ name, ok, summary, duration_ms }) {
  const mark = ok ? C.grn('✓') : C.red('✗');
  const dur = duration_ms != null ? C.dim(`${duration_ms}ms`) : '';
  return `  ${mark} ${C.dim(name)} ${dur}  ${summary.slice(0, 260)}`;
}

// Per-turn usage footer.
export function renderUsage({ input, output, cache_read, cache_write, usd, ctx_pct }) {
  const parts = [];
  if (input  != null) parts.push(`in=${input}`);
  if (output != null) parts.push(`out=${output}`);
  if (cache_read)     parts.push(`cache_hit=${cache_read}`);
  if (cache_write)    parts.push(`cache_write=${cache_write}`);
  if (usd    != null) parts.push(`$=${usd.toFixed(4)}`);
  if (ctx_pct!= null) parts.push(`ctx=${ctx_pct}%`);
  return C.dim(`   ${parts.join('  ')}`);
}

// Thinking summary — rendered as a single compact line once the block is done.
export function renderThinkingSummary({ lines, chars, preview }) {
  return `${C.dim('◇ thought')} ${C.dim(`(${lines}L / ${chars}c)`)}  ${C.dim(preview + (chars > 80 ? '…' : ''))}`;
}

// Verify verdict banner.
export function renderVerify(verdict) {
  if (!verdict) return '';
  const v = verdict.verdict || 'unknown';
  const color = v === 'approve' ? C.grn : v === 'revise' ? C.ylw : C.dim;
  const issues = (verdict.issues || []).slice(0, 3).join('; ');
  return `${color('■')} verify: ${color(v)}  ${C.dim('conf=' + (verdict.confidence ?? '?'))}${issues ? '  ' + C.dim('— ' + issues) : ''}`;
}

// Footer — rendered persistently in interactive mode (below the composer).
export function renderFooter({ model, tier, usd, ctx_pct, tools }) {
  const bits = [
    `${C.mag('golduck')}`,
    `${C.dim('model')} ${model}`,
    `${C.dim('tier')} ${tier}`,
    usd != null ? `${C.dim('$')} ${usd.toFixed(4)}` : null,
    ctx_pct != null ? `${C.dim('ctx')} ${ctx_pct}%` : null,
    tools != null ? `${C.dim('tools')} ${tools}` : null,
    C.dim('esc ⏎ send'),
    C.dim('^T trace'),
    C.dim('^C quit'),
  ].filter(Boolean);
  return bits.join('  ' + C.dim('│') + '  ');
}

export { C, box, stripAnsi };
