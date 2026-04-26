/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI shared time formatters (runtime/tui/util/format_time.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Consolidates the N copies of timeAgo / clockHHMM / stampISO that were
 * inlined across Memory, Sessions, Spend, Dag, and Reflect overlays.
 * ───────────────────────────────────────────────────────────────────────── */

/** Human "x ago" string. Accepts ISO string or ms epoch. */
export function timeAgo(ts) {
  if (ts == null) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, Date.now() - t);
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / (7 * 86_400_000))}w ago`;
}

/** HH:MM string from an ISO or ms epoch. */
export function clockHHMM(ts) {
  if (ts == null) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (!Number.isFinite(d.valueOf())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** ISO stamp, seconds precision. */
export function stampISO(ts) {
  if (ts == null) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}
