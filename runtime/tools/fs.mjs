/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool suite: fs ops (read/write/ls/glob/grep)
 * ───────────────────────────────────────────────────────────────────────── */
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve as presolve, relative, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_READ_BYTES = 400_000;

export const SCHEMAS = [
  {
    name: 'read',
    description: 'Read a file. Returns text content, truncated if >400KB. Prefer this over shell `cat`.',
    input_schema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: 'Byte offset to start reading from' },
        limit: { type: 'number', description: 'Max bytes to read' },
      },
    },
  },
  {
    name: 'write',
    description: 'Write a file. Creates parent dirs as needed. Refuses to overwrite without overwrite:true.',
    input_schema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'ls',
    description: 'List a directory. Non-recursive by default.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.' },
        recursive: { type: 'boolean', default: false },
        max_entries: { type: 'number', default: 500 },
      },
    },
  },
  {
    name: 'glob',
    description: 'Glob files matching a pattern. Uses ripgrep when available, falls back to find. Ranked by most-recently-modified.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Regex or substring to match against paths' },
        cwd: { type: 'string', default: '.' },
        max: { type: 'number', default: 100 },
      },
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with ripgrep (falls back to plain grep -rn when rg is absent). Returns `path:line: match` lines.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', default: '.' },
        case_insensitive: { type: 'boolean', default: false },
        context: { type: 'number', description: 'Lines of context around match', default: 0 },
        max: { type: 'number', default: 200 },
      },
    },
  },
];

export async function read({ path, offset = 0, limit = MAX_READ_BYTES }) {
  if (!existsSync(path)) return { ok: false, error: `ENOENT: ${path}` };
  const st = statSync(path);
  if (st.isDirectory()) return { ok: false, error: `is_directory: ${path}` };
  const buf = readFileSync(path);
  const slice = buf.slice(offset, offset + Math.min(limit, MAX_READ_BYTES));
  return {
    ok: true,
    path,
    bytes: st.size,
    offset,
    content: slice.toString('utf8'),
    truncated: slice.length < (buf.length - offset),
  };
}

export async function write({ path, content, overwrite = false }) {
  if (existsSync(path) && !overwrite) {
    return { ok: false, error: `exists: ${path} (pass overwrite:true to replace)` };
  }
  mkdirSync(dirname(presolve(path)), { recursive: true });
  writeFileSync(path, content);
  return { ok: true, path, bytes: Buffer.byteLength(content) };
}

export async function ls({ path = '.', recursive = false, max_entries = 500 }) {
  if (!existsSync(path)) return { ok: false, error: `ENOENT: ${path}` };
  const out = [];
  function walk(p, depth) {
    if (out.length >= max_entries) return;
    const entries = readdirSync(p, { withFileTypes: true });
    for (const ent of entries) {
      if (out.length >= max_entries) break;
      const full = join(p, ent.name);
      out.push({ path: relative(path, full) || ent.name, kind: ent.isDirectory() ? 'dir' : (ent.isSymbolicLink() ? 'link' : 'file') });
      if (recursive && ent.isDirectory() && depth < 5 && !ent.name.startsWith('.') && ent.name !== 'node_modules' && ent.name !== 'target') {
        walk(full, depth + 1);
      }
    }
  }
  walk(path, 0);
  return { ok: true, path, entries: out, truncated: out.length >= max_entries };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function glob({ pattern, cwd = '.', max = 100 }) {
  // rg is the fast path; falls back to `find` so golduck still works without ripgrep installed.
  const rg = spawnSync('rg', ['--files', '--hidden', '--glob', '!.git'], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let all;
  let engine;
  if (rg.status === 0 || rg.status === 1 || rg.stdout) {
    all = rg.stdout.split('\n').filter(Boolean);
    engine = 'rg';
  } else {
    const find = spawnSync('find', [cwd, '-type', 'f',
      '-not', '-path', '*/.git/*',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/target/*'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (find.status !== 0 && !find.stdout) {
      return { ok: false, error: 'neither rg nor find produced results; install ripgrep for best results' };
    }
    const strip = new RegExp('^' + escapeRegex(cwd) + '/?');
    all = find.stdout.split('\n').filter(Boolean).map((p) => p.replace(strip, ''));
    engine = 'find-fallback';
  }
  let matched;
  try {
    const re = new RegExp(pattern);
    matched = all.filter((f) => re.test(f));
  } catch {
    matched = all.filter((f) => f.includes(pattern));
  }
  const ranked = matched.map((f) => {
    try { return { path: f, mtime: statSync(join(cwd, f)).mtimeMs }; }
    catch { return { path: f, mtime: 0 }; }
  }).sort((a, b) => b.mtime - a.mtime).slice(0, max).map((x) => x.path);
  return { ok: true, matches: ranked, count: ranked.length, total_candidates: all.length, engine };
}

export async function grep({ pattern, path = '.', case_insensitive = false, context = 0, max = 200 }) {
  const rgArgs = ['-n', '--hidden', '--glob', '!.git'];
  if (case_insensitive) rgArgs.push('-i');
  if (context > 0) rgArgs.push('-C', String(context));
  rgArgs.push('-m', String(max));
  rgArgs.push(pattern, path);
  const rg = spawnSync('rg', rgArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (rg.status === 0 || rg.status === 1) {
    const lines = (rg.stdout || '').split('\n').filter(Boolean).slice(0, max);
    return { ok: true, matches: lines, count: lines.length, truncated: lines.length >= max, engine: 'rg' };
  }
  if (rg.status === 2) return { ok: false, error: rg.stderr.slice(0, 800) };
  // Fallback: plain grep -rn.
  const grepArgs = ['-rn'];
  if (case_insensitive) grepArgs.push('-i');
  if (context > 0) grepArgs.push('-C', String(context));
  grepArgs.push('--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=target');
  grepArgs.push(pattern, path);
  const gp = spawnSync('grep', grepArgs, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (gp.status === 0 || gp.status === 1) {
    const lines = (gp.stdout || '').split('\n').filter(Boolean).slice(0, max);
    return { ok: true, matches: lines, count: lines.length, truncated: lines.length >= max, engine: 'grep-fallback' };
  }
  return { ok: false, error: `neither rg nor grep ran: ${(gp.stderr || 'unknown').slice(0, 800)}` };
}
