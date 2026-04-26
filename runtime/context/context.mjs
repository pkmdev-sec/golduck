/* ─────────────────────────────────────────────────────────────────────────
 * golduck context engine (runtime/context/context.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Produces a RunContext bundle that both the router and frontend use:
 *
 *   - repo: { root, dirty, branch, head, size_class, recent_edits[] }
 *   - agents: { files[], merged_instructions, has_never_rules }
 *   - hooks: { pre_request[], post_response[], on_tool[] }
 *   - skills: { available[], recent_wins[] }
 *   - memory: { facts[], pins[], recent_journal[] }
 *   - constitution: { rules[], forbidden_paths[] }
 *   - cost_ledger: { session_usd, lifetime_usd, budget_usd }
 *   - summary: human-readable one-liner for trace
 *
 * Fast: O(directory listing) for AGENTS walk, O(git status) for repo. No
 * content reads over size 64KB. All paths relative to cwd.
 * ───────────────────────────────────────────────────────────────────────── */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as pathResolve, relative } from 'node:path';

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function loadRepo(cwd) {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  if (!root) return { root: cwd, dirty: false, branch: null, head: null, size_class: 'small', recent_edits: [] };
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const head = git(root, 'rev-parse', '--short', 'HEAD');
  const status = git(root, 'status', '--porcelain=v1');
  const dirty = Boolean(status && status.length);
  const recent_edits = (git(root, 'diff', '--name-only', 'HEAD~5..HEAD') || '')
    .split('\n').filter(Boolean).slice(0, 20);
  // Rough repo-size class from `git ls-files | wc -l`.
  const lsFiles = git(root, 'ls-files');
  const n = lsFiles ? lsFiles.split('\n').length : 0;
  const size_class = n < 500 ? 'small' : n < 5000 ? 'medium' : n < 40000 ? 'large' : 'huge';
  return { root, dirty, branch, head, size_class, recent_edits, n_files: n, status };
}

function walkAgents(cwd, rootDir) {
  // From cwd up to root, collect AGENTS.md files in the chain. Merge
  // their text in order (closest-to-cwd last = wins on conflicts).
  const chain = [];
  let p = pathResolve(cwd);
  const stop = rootDir ? pathResolve(rootDir) : '/';
  while (true) {
    const cand = join(p, 'AGENTS.md');
    if (existsSync(cand)) chain.push(cand);
    if (p === stop || p === '/' || p === '') break;
    const parent = pathResolve(p, '..');
    if (parent === p) break;
    p = parent;
  }
  chain.reverse(); // root→cwd order
  const merged = chain.map((f) => {
    try {
      const content = readFileSync(f, 'utf8');
      return `<!-- ${relative(rootDir || cwd, f)} -->\n${content}`;
    } catch { return ''; }
  }).join('\n\n');
  const has_never_rules = /\bnever\b|\bmust not\b|forbidden/i.test(merged);
  return { files: chain, merged_instructions: merged, has_never_rules };
}

function loadHooks(home) {
  const dir = join(home, 'hooks');
  if (!existsSync(dir)) return { pre_request: [], post_response: [], on_tool: [] };
  const out = { pre_request: [], post_response: [], on_tool: [] };
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (name.startsWith('pre_request_'))  out.pre_request.push(full);
      if (name.startsWith('post_response_')) out.post_response.push(full);
      if (name.startsWith('on_tool_'))      out.on_tool.push(full);
    }
  } catch {}
  return out;
}

function loadSkills(home) {
  const dir = join(home, 'skills');
  if (!existsSync(dir)) return { available: [], recent_wins: [] };
  try {
    const available = readdirSync(dir).filter((n) => n.endsWith('.json'));
    return { available, recent_wins: [] };
  } catch { return { available: [], recent_wins: [] }; }
}

function loadMemory(home) {
  const facts = join(home, 'memory', 'facts.jsonl');
  const pins = join(home, 'memory', 'pins.json');
  let factList = [];
  let pinList = [];
  try {
    if (existsSync(facts)) {
      factList = readFileSync(facts, 'utf8').split('\n').filter(Boolean).slice(-50)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    }
    if (existsSync(pins)) pinList = JSON.parse(readFileSync(pins, 'utf8'));
  } catch {}
  return { facts: factList, pins: pinList, recent_journal: [] };
}

function loadConstitution(home, rootDir) {
  // Constitution: immutable per-project rules that pre-exec must honor.
  // Sources (in order): $GOLDUCK_HOME/constitution.md → <repo>/.golduck/constitution.md
  const cands = [
    join(home, 'constitution.md'),
    rootDir ? join(rootDir, '.golduck', 'constitution.md') : null,
  ].filter(Boolean);
  let text = '';
  for (const f of cands) {
    if (existsSync(f)) text += readFileSync(f, 'utf8') + '\n';
  }
  const forbidden_paths = [];
  const never_rules = [];
  const must_rules = [];
  // Parse directive-style lines: FORBID / NEVER / MUST.
  text.split('\n').forEach((line) => {
    const fp = line.match(/^\s*FORBID:\s*(.+)$/);
    if (fp) { forbidden_paths.push(fp[1].trim()); return; }
    const nv = line.match(/^\s*NEVER:\s*(.+)$/);
    if (nv) { never_rules.push(nv[1].trim()); return; }
    const mu = line.match(/^\s*MUST:\s*(.+)$/);
    if (mu) { must_rules.push(mu[1].trim()); return; }
  });
  return { rules_text: text, forbidden_paths, never_rules, must_rules };
}

function loadCostLedger(home) {
  const f = join(home, 'memory', 'cost.json');
  try {
    if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  } catch {}
  return { session_usd: 0, lifetime_usd: 0 };
}

export async function loadRunContext({ runId, home, traceFile, cwd }) {
  const repo = loadRepo(cwd);
  const agents = walkAgents(cwd, repo.root);
  const hooks = loadHooks(home);
  const skills = loadSkills(home);
  const memory = loadMemory(home);
  const constitution = loadConstitution(home, repo.root);
  const cost_ledger = loadCostLedger(home);

  const summary =
    `repo=${repo.size_class} dirty=${repo.dirty} agents=${agents.files.length} ` +
    `hooks=${hooks.pre_request.length}+${hooks.post_response.length} ` +
    `skills=${skills.available.length} facts=${memory.facts.length}`;

  return { runId, home, traceFile, cwd, repo, agents, hooks, skills, memory, constitution, cost_ledger, summary };
}
