/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool: apply_patch (runtime/tools/apply_patch.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Codex-style patch format: surgical, deterministic edits. Supports
 *   *** Begin Patch
 *   *** Add File: path
 *   +content
 *   *** Update File: path
 *   @@ <hunk context>
 *   -old
 *   +new
 *   *** Delete File: path
 *   *** End Patch
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve as presolve } from 'node:path';

export const SCHEMA = {
  name: 'apply_patch',
  description:
    'Apply a Codex-format patch. Supports Add/Update/Delete File operations. ' +
    'Update hunks use @@ context lines; -lines removed, +lines added, " " lines unchanged. ' +
    'All edits atomic: either the whole patch applies or none does.',
  input_schema: {
    type: 'object',
    required: ['patch'],
    properties: {
      patch: { type: 'string', description: 'Patch body starting with *** Begin Patch and ending with *** End Patch.' },
      dry_run: { type: 'boolean', default: false, description: 'Validate only; do not write.' },
    },
  },
};

/** Best-effort unified-diff → Codex-patch converter. Now covers Update
 *  (simple hunks), Add File (`new file mode` / `--- /dev/null`), and
 *  Delete File (`deleted file mode` / `+++ /dev/null`). Multi-file
 *  patches are fine; each file block is translated independently.
 *
 *  Things we still skip on purpose:
 *    - rename (`rename from` / `rename to`) — the Codex format has no
 *      direct analog, so we fall back to the `missing *** Begin Patch`
 *      error path and the caller has to emit the two-op (Delete + Add) form.
 *    - binary patches — unified format doesn't carry the bytes inline. */
function unifiedToCodex(src) {
  const out = ['*** Begin Patch'];
  const lines = src.split('\n');
  let i = 0;
  let hadAny = false;

  // Helper: does a line look like the start of another file block?
  const isFileBoundary = (s) => typeof s === 'string' &&
    (s.startsWith('diff --git') || s.startsWith('--- a/') || s.startsWith('--- /dev/null'));

  while (i < lines.length) {
    const hdr = lines[i];
    let path = null;
    let mode = 'update'; // 'add' | 'delete' | 'update'

    // Case 1: 'diff --git a/X b/Y' header. The subsequent metadata lines
    // tell us whether this is a new/deleted/updated file.
    const ghMatch = hdr.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (ghMatch) {
      path = ghMatch[2];
      i++;
      // Walk metadata block (index, mode, --- / +++) until the first @@.
      while (i < lines.length && !lines[i].startsWith('@@')) {
        const ml = lines[i];
        if (/^new file mode/.test(ml)) mode = 'add';
        else if (/^deleted file mode/.test(ml)) mode = 'delete';
        else if (ml.startsWith('--- /dev/null')) mode = 'add';
        else if (ml.startsWith('+++ /dev/null')) mode = 'delete';
        i++;
      }
    }
    // Case 2: bare '--- a/X' / '--- /dev/null' + '+++ b/Y' / '+++ /dev/null'.
    else if (hdr.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const oldSide = hdr.slice(4).trim();
      const newSide = lines[i + 1].slice(4).trim();
      if (oldSide === '/dev/null' && newSide.startsWith('b/')) {
        path = newSide.slice(2);
        mode = 'add';
      } else if (newSide === '/dev/null' && oldSide.startsWith('a/')) {
        path = oldSide.slice(2);
        mode = 'delete';
      } else if (oldSide.startsWith('a/') && newSide.startsWith('b/')) {
        path = newSide.slice(2);
      }
      i += 2;
    } else {
      i++;
      continue;
    }

    if (!path) continue;

    if (mode === 'delete') {
      out.push(`*** Delete File: ${path}`);
      // Skip the hunk body — Delete File in Codex format needs no @@ block.
      while (i < lines.length && !isFileBoundary(lines[i])) i++;
      hadAny = true;
      continue;
    }

    if (mode === 'add') {
      out.push(`*** Add File: ${path}`);
      // Unified diff for a new file looks like:
      //   @@ -0,0 +1,N @@
      //   +line1
      //   +line2
      // Collect every '+' line (the file body) and ignore @@ markers.
      while (i < lines.length && !isFileBoundary(lines[i])) {
        if (lines[i].startsWith('+') && !lines[i].startsWith('+++')) {
          out.push(lines[i]);  // Codex Add File expects '+' prefix; keep it.
        }
        // @@ and '-' lines (shouldn't appear in add) are just skipped.
        i++;
      }
      hadAny = true;
      continue;
    }

    // mode === 'update'
    out.push(`*** Update File: ${path}`);
    while (i < lines.length && lines[i].startsWith('@@')) {
      const ctx = lines[i].replace(/^@@[^@]*@@/, '').trim();
      out.push(`@@ ${ctx}`);
      i++;
      while (i < lines.length && !lines[i].startsWith('@@') && !isFileBoundary(lines[i])) {
        const c = lines[i][0];
        if (c === '+' || c === '-' || c === ' ') out.push(lines[i]);
        else if (lines[i] === '') out.push(' ');
        i++;
      }
      hadAny = true;
    }
  }

  if (!hadAny) return null;
  out.push('*** End Patch');
  return out.join('\n');
}

function parsePatch(src) {
  // Auto-upgrade unified diff → Codex format.
  if (/^(?:diff --git |--- a\/)/m.test(src) && !src.includes('*** Begin Patch')) {
    const upgraded = unifiedToCodex(src);
    if (upgraded) src = upgraded;
  }
  const lines = src.split('\n');
  if (!lines[0]?.includes('*** Begin Patch')) throw new Error('missing *** Begin Patch header');
  const ops = [];
  let i = 1;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || ln === '') { i++; continue; }
    if (ln.startsWith('*** End Patch')) break;
    if (ln.startsWith('*** Add File: ')) {
      const path = ln.slice('*** Add File: '.length).trim();
      i++;
      const body = [];
      while (i < lines.length && !lines[i].startsWith('***')) {
        if (lines[i].startsWith('+')) body.push(lines[i].slice(1));
        else if (lines[i] === '') body.push('');
        else throw new Error(`Add File line must start with '+': "${lines[i]}"`);
        i++;
      }
      ops.push({ kind: 'add', path, content: body.join('\n') });
      continue;
    }
    if (ln.startsWith('*** Delete File: ')) {
      ops.push({ kind: 'delete', path: ln.slice('*** Delete File: '.length).trim() });
      i++; continue;
    }
    if (ln.startsWith('*** Update File: ')) {
      const path = ln.slice('*** Update File: '.length).trim();
      i++;
      const hunks = [];
      while (i < lines.length && !lines[i].startsWith('***')) {
        if (!lines[i].startsWith('@@')) throw new Error(`expected @@ hunk, got: "${lines[i]}"`);
        const context = lines[i].slice(2).trim();
        i++;
        const ops2 = [];
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('***')) {
          const first = lines[i][0];
          if (first === '-' || first === '+' || first === ' ') {
            ops2.push({ kind: first, text: lines[i].slice(1) });
          } else if (lines[i] === '') {
            ops2.push({ kind: ' ', text: '' });
          } else {
            throw new Error(`unexpected line in hunk: "${lines[i]}"`);
          }
          i++;
        }
        hunks.push({ context, ops: ops2 });
      }
      ops.push({ kind: 'update', path, hunks });
      continue;
    }
    throw new Error(`unrecognized directive: "${ln}"`);
  }
  return ops;
}

function applyHunk(fileLines, hunk) {
  const oldLines = [];
  const newLines = [];
  for (const op of hunk.ops) {
    if (op.kind === ' ') { oldLines.push(op.text); newLines.push(op.text); }
    else if (op.kind === '-') { oldLines.push(op.text); }
    else if (op.kind === '+') { newLines.push(op.text); }
  }
  if (!oldLines.length) {
    if (!hunk.context) throw new Error('empty hunk requires @@ context');
    // Pure insertion: prefer exact context match, then a whitespace-insensitive fallback.
    let idx = fileLines.findIndex((l) => l.includes(hunk.context));
    if (idx < 0) {
      const ctx = String(hunk.context).replace(/\s+/g, ' ').trim();
      idx = fileLines.findIndex((l) => l.replace(/\s+/g, ' ').trim().includes(ctx));
    }
    if (idx < 0) throw new Error(`context not found: ${hunk.context}`);
    fileLines.splice(idx + 1, 0, ...newLines);
    return fileLines;
  }
  const sz = oldLines.length;

  // Pass 1: strict exact match.
  outer: for (let i = 0; i <= fileLines.length - sz; i++) {
    for (let j = 0; j < sz; j++) {
      if (fileLines[i + j] !== oldLines[j]) continue outer;
    }
    fileLines.splice(i, sz, ...newLines);
    return fileLines;
  }

  // Pass 2: whitespace-insensitive match (leading/trailing ws ignored per line).
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const oldNorm = oldLines.map(norm);
  outer2: for (let i = 0; i <= fileLines.length - sz; i++) {
    for (let j = 0; j < sz; j++) {
      if (norm(fileLines[i + j]) !== oldNorm[j]) continue outer2;
    }
    fileLines.splice(i, sz, ...newLines);
    return fileLines;
  }

  throw new Error(`hunk did not match in file (context: ${hunk.context || '<none>'})`);
}

export async function execute({ patch, dry_run = false }) {
  let ops;
  try { ops = parsePatch(patch); }
  catch (e) { return { ok: false, error: `parse: ${e.message}` }; }

  // Validate first pass.
  const plans = [];
  for (const op of ops) {
    if (op.kind === 'add') {
      if (existsSync(op.path)) return { ok: false, error: `Add File already exists: ${op.path}` };
      plans.push(op);
    } else if (op.kind === 'delete') {
      if (!existsSync(op.path)) return { ok: false, error: `Delete File missing: ${op.path}` };
      plans.push(op);
    } else if (op.kind === 'update') {
      if (!existsSync(op.path)) return { ok: false, error: `Update File missing: ${op.path}` };
      const text = readFileSync(op.path, 'utf8');
      let lines = text.split('\n');
      try {
        for (const h of op.hunks) lines = applyHunk(lines, h);
      } catch (e) { return { ok: false, error: `${op.path}: ${e.message}` }; }
      plans.push({ ...op, _final: lines.join('\n') });
    }
  }

  if (dry_run) {
    return { ok: true, dry_run: true, ops: plans.map((p) => ({ kind: p.kind, path: p.path })) };
  }
  // Second pass: actually write.
  for (const op of plans) {
    if (op.kind === 'add') {
      mkdirSync(dirname(presolve(op.path)), { recursive: true });
      writeFileSync(op.path, op.content);
    } else if (op.kind === 'delete') {
      unlinkSync(op.path);
    } else if (op.kind === 'update') {
      writeFileSync(op.path, op._final);
    }
  }
  return { ok: true, ops: plans.map((p) => ({ kind: p.kind, path: p.path })) };
}
