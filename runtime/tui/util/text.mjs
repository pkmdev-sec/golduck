/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI shared text helpers (runtime/tui/util/text.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Minimal, dependency-free formatting primitives used across overlays.
 * ───────────────────────────────────────────────────────────────────────── */

export function truncate(s, n) {
  const str = String(s ?? '');
  if (!n || n <= 0) return str;
  if (str.length <= n) return str;
  return str.slice(0, Math.max(1, n - 1)) + '…';
}

export function padRight(s, n) {
  const str = String(s ?? '');
  if (str.length >= n) return str;
  return str + ' '.repeat(n - str.length);
}

export function human(n) {
  if (n == null) return '?';
  const v = Number(n);
  if (!Number.isFinite(v)) return '?';
  if (v < 1000) return String(v);
  if (v < 1_000_000) return (v / 1000).toFixed(1) + 'k';
  return (v / 1_000_000).toFixed(2) + 'M';
}
