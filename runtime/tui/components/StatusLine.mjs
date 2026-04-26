/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI / StatusLine — droidx parity footer
 * ─────────────────────────────────────────────────────────────────────────
 * In droidx the "Auto (…)"/model block is painted ABOVE the composer and
 * the "? for help"/ghost line goes BELOW the composer. We mirror that by
 * exporting two components:
 *
 *   <ModeLine/>    — two-row: autonomy label + hint  /  model + hint
 *   <StatusLine/>  — one-row: "? for help" + crumbs  /  "GHOSTLY G"
 *
 * App.mjs renders <ModeLine/> just above <Composer/>, and <StatusLine/>
 * below it, matching droidx's exact layout.
 * ───────────────────────────────────────────────────────────────────────── */
import React from 'react';
import { Box, Text } from 'ink';
import { COLORS, GLYPH } from '../theme.mjs';

const h = React.createElement;

function widthOf(s) { return Array.from(String(s)).length; }

function formatUptime(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

// Droidx autonomy tiers. Defaults to 'high' so the footer reads
// "Auto (High) - allow all commands" just like a fresh droidx launch.
function resolveAutonomy() {
  const raw = (process.env.GOLDUCK_AUTONOMY || 'high').toLowerCase();
  switch (raw) {
    case 'off':    return { label: 'Auto (Off)',  blurb: 'all actions require approval', color: COLORS.textPrimary, dim: true };
    case 'low':    return { label: 'Auto (Low)',  blurb: 'edits and read-only commands', color: COLORS.primary };
    case 'medium': case 'med':
                   return { label: 'Auto (Med)',  blurb: 'allow reversible commands',    color: COLORS.primary };
    case 'high':
    default:       return { label: 'Auto (High)', blurb: 'allow all commands',           color: COLORS.primary };
  }
}

export function ModeLine({ statusLine }) {
  const cols = Math.max(
    40,
    process.stdout.columns || parseInt(process.env.COLUMNS || '100', 10),
  );

  const autonomy = resolveAutonomy();
  const model = statusLine?.model || 'claude-opus-4-7';
  const tier  = statusLine?.tier  || 'opus';
  const modelRight = `${model} [${tier}]`;

  // Inner width = columns minus the paddingX:1 on each side.
  const inner = Math.max(20, cols - 2);

  const topLeftPlain = `${autonomy.label} - ${autonomy.blurb}`;
  const topPad = Math.max(1, inner - widthOf(topLeftPlain) - widthOf(modelRight));

  const hintLeft  = 'ctrl+H help · ctrl+L clear · esc cancel';
  const hintRight = 'ctrl+T trace · ctrl+M memory';
  const hintPad = Math.max(1, inner - widthOf(hintLeft) - widthOf(hintRight));

  // If the viewport is too narrow to show both sides, drop the right column.
  const showModelRight = inner >= widthOf(topLeftPlain) + widthOf(modelRight) + 2;
  const showHintRight  = inner >= widthOf(hintLeft) + widthOf(hintRight) + 2;

  return h(Box, { flexDirection: 'column', width: cols },
    h(Box, { paddingX: 1, width: cols },
      h(Text, { color: autonomy.color, bold: !autonomy.dim }, autonomy.label),
      h(Text, { color: COLORS.textMuted }, ' - '),
      h(Text, { color: autonomy.dim ? COLORS.textMuted : autonomy.color }, autonomy.blurb),
      showModelRight && h(Text, null, ' '.repeat(topPad)),
      showModelRight && h(Text, { color: COLORS.textPrimary, bold: true }, modelRight),
    ),
    h(Box, { paddingX: 1, width: cols },
      h(Text, { color: COLORS.textMuted }, hintLeft),
      showHintRight && h(Text, null, ' '.repeat(hintPad)),
      showHintRight && h(Text, { color: COLORS.textMuted }, hintRight),
    ),
  );
}

export function StatusLine({
  statusLine,
  interrupted,
  busy,
  busyLabel = null,
  tick = 0,
  sessionStart = null,
  msgCount = 0,
}) {
  const cols = Math.max(
    40,
    process.stdout.columns || parseInt(process.env.COLUMNS || '100', 10),
  );

  const helpText = interrupted
    ? 'ctrl+C again to quit'
    : (busy && busyLabel
        ? `${GLYPH.spinner[tick % GLYPH.spinner.length]} ${busyLabel}…`
        : '? for help');

  const ctxPct  = statusLine?.ctx_pct ?? 0;
  const usdSpent = statusLine?.usd ?? 0;
  const tools = statusLine?.tools ?? 0;
  const uptime = sessionStart && (Date.now() - sessionStart) > 5000
    ? formatUptime(Date.now() - sessionStart)
    : null;

  const crumbsParts = [];
  if (ctxPct) crumbsParts.push(`ctx ${ctxPct}%`);
  if (usdSpent) crumbsParts.push(`$${usdSpent.toFixed(4)}`);
  if (tools) crumbsParts.push(`${tools} tools`);
  if (uptime) crumbsParts.push(uptime);
  if (msgCount > 0) crumbsParts.push(`${msgCount} msg${msgCount === 1 ? '' : 's'}`);
  const crumbs = crumbsParts.join(' · ');

  const ghostTag = 'GHOSTLY G';
  const inner = Math.max(20, cols - 2);
  const leftW = widthOf(helpText) + (crumbs ? widthOf(`   ${crumbs}`) : 0);
  const showGhost = inner >= leftW + widthOf(ghostTag) + 2;
  const pad = Math.max(1, inner - leftW - widthOf(ghostTag));

  return h(Box, { paddingX: 1, width: cols },
    h(Text, { color: busy ? COLORS.primary : COLORS.textMuted }, helpText),
    crumbs && h(Text, { color: COLORS.textMuted }, `   ${crumbs}`),
    showGhost && h(Text, null, ' '.repeat(pad)),
    showGhost && h(Text, { color: COLORS.textMuted }, ghostTag),
  );
}
