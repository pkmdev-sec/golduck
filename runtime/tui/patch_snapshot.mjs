/* ─────────────────────────────────────────────────────────────────────────
 * Patch snapshot + undo (runtime/tui/patch_snapshot.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Before every `apply_patch` executes, snapshot the pre-image of every
 * file it touches to `$GOLDUCK_HOME/state/undo/<runId>/<N>/`. On `/undo`
 * we revert the most recent snapshot.
 *
 * Why: coding agents occasionally make bad edits. `/undo` is the "get me
 * back to where I was one minute ago" panic button.
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

function undoBase() {
  const home = process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
  return join(home, 'state', 'undo');
}

/** Parse `apply_patch` text, return the set of file paths it touches. */
export function filesFromPatch(patchText) {
  if (!patchText || typeof patchText !== 'string') return [];
  const re = /\*\*\* (?:Add|Update|Delete) File: (.+)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(patchText))) out.add(m[1].trim());
  return [...out];
}

/** Shared low-level snapshotter — writes a new slot under the runDir,
 *  returns { slot, files }. Callers pass an already-resolved list of file paths. */
function _snapshotFiles({ runId, files }) {
  if (!files || !files.length) return null;
  const runDir = join(undoBase(), runId || 'default');
  mkdirSync(runDir, { recursive: true });
  const existing = readdirSync(runDir).filter((f) => /^\d+$/.test(f)).map(Number);
  const n = existing.length ? Math.max(...existing) + 1 : 1;
  const slot = join(runDir, String(n));
  mkdirSync(slot, { recursive: true });
  const manifest = [];
  for (const rel of files) {
    try {
      const existed = existsSync(rel);
      const payload = existed ? readFileSync(rel, 'utf8') : null;
      if (existed) {
        const dst = join(slot, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, payload);
      }
      manifest.push({ path: rel, existed });
    } catch { /* best-effort */ }
  }
  writeFileSync(join(slot, 'manifest.json'), JSON.stringify({
    ts: new Date().toISOString(), runId, files: manifest,
  }, null, 2));
  return { slot: n, files: manifest };
}

/** Snapshot before a single-file `write` tool call. */
export function snapshotBeforeWrite({ runId, path: filePath }) {
  if (!filePath) return null;
  return _snapshotFiles({ runId, files: [filePath] });
}

/** Snapshot pre-images of the given files into a new undo slot. Returns slot id. */
export function snapshotBeforePatch({ runId, patchText }) {
  const files = filesFromPatch(patchText);
  if (!files.length) return null;
  return _snapshotFiles({ runId, files });
}

/** List every undo slot known for this runId (or all runs if omitted),
 *  newest first. Each entry: { runId, slot, dir, mtime, files: [{path, existed}] }.
 *  Used by `golduck /undo --list` / overlay; does NOT modify anything. */
export function listUndoSlots({ runId } = {}) {
  const base = undoBase();
  if (!existsSync(base)) return [];
  try {
    const runs = runId ? [runId] : readdirSync(base);
    const out = [];
    for (const r of runs) {
      const rDir = join(base, r);
      if (!existsSync(rDir)) continue;
      let slots;
      try { slots = readdirSync(rDir).filter((f) => /^\d+$/.test(f)); } catch { continue; }
      for (const slot of slots) {
        const dir = join(rDir, slot);
        let manifest = { files: [] };
        try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch {}
        let mtime = 0;
        try { mtime = statSync(dir).mtimeMs; } catch {}
        out.push({
          runId: r,
          slot: Number(slot),
          dir,
          mtime,
          files: (manifest.files || []).map((f) => ({ path: f.path, existed: !!f.existed })),
        });
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/** Revert the newest snapshot in this runId; if runId missing, the newest anywhere. */
export function undoLast({ runId } = {}) {
  const base = undoBase();
  if (!existsSync(base)) return { ok: false, error: 'no_snapshots' };
  const runs = runId && existsSync(join(base, runId))
    ? [runId]
    : readdirSync(base).filter((d) => {
        try { return readdirSync(join(base, d)).length > 0; } catch { return false; }
      });
  if (!runs.length) return { ok: false, error: 'no_snapshots' };

  // Pick the newest slot across picked runs by mtime.
  let pick = null;
  for (const r of runs) {
    const rDir = join(base, r);
    const slots = readdirSync(rDir).filter((f) => /^\d+$/.test(f));
    for (const slot of slots) {
      const p = join(rDir, slot);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch {}
      if (!pick || mtime > pick.mtime) pick = { dir: p, mtime, runId: r, slot };
    }
  }
  if (!pick) return { ok: false, error: 'no_slots' };

  const manifest = JSON.parse(readFileSync(join(pick.dir, 'manifest.json'), 'utf8'));
  const restored = [];
  const deleted = [];
  for (const f of manifest.files || []) {
    try {
      if (f.existed) {
        const src = join(pick.dir, f.path);
        const body = readFileSync(src, 'utf8');
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, body);
        restored.push(f.path);
      } else {
        // File didn't exist before the patch — revert == delete.
        if (existsSync(f.path)) { rmSync(f.path, { force: true }); deleted.push(f.path); }
      }
    } catch { /* best-effort */ }
  }
  // Remove the slot now that we've undone it.
  try { rmSync(pick.dir, { recursive: true, force: true }); } catch {}
  return { ok: true, restored, deleted, slot: pick.slot, runId: pick.runId };
}
