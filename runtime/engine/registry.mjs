/* ─────────────────────────────────────────────────────────────────────────
 * golduck tool registry (runtime/engine/registry.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Binds every tool (native + MCP) into a single catalog with:
 *   - a list of Anthropic-format {name, description, input_schema}
 *   - a dispatch(name, input, onProgress) → Promise<result>
 *
 * MCP tools are name-prefixed with their server: "obscura__browser_open".
 * ───────────────────────────────────────────────────────────────────────── */
import * as shellT from '../tools/shell.mjs';
import * as fsT    from '../tools/fs.mjs';
import * as patchT from '../tools/apply_patch.mjs';
import * as rlmT   from '../tools/rlm.mjs';
import * as memT   from '../tools/memory.mjs';
import * as webT   from '../tools/web.mjs';
import * as skillsT from '../tools/skills.mjs';
import { loadAllMCP } from '../mcp/client.mjs';

export async function buildRegistry() {
  const entries = [];

  // Native tools.
  entries.push({ schema: shellT.SCHEMA, executor: shellT.execute });
  for (const s of fsT.SCHEMAS) {
    let fn;
    if (s.name === 'read')  fn = fsT.read;
    else if (s.name === 'write') fn = fsT.write;
    else if (s.name === 'ls')    fn = fsT.ls;
    else if (s.name === 'glob')  fn = fsT.glob;
    else if (s.name === 'grep')  fn = fsT.grep;
    entries.push({ schema: s, executor: fn });
  }
  entries.push({ schema: patchT.SCHEMA, executor: patchT.execute });

  for (const s of rlmT.SCHEMAS) {
    const fn = rlmT[s.name];
    if (!fn) continue;
    entries.push({ schema: s, executor: fn });
  }

  for (const s of memT.SCHEMAS) {
    const fn = memT[s.name];
    if (!fn) continue;
    entries.push({ schema: s, executor: fn });
  }

  entries.push({ schema: webT.SCHEMA, executor: webT.execute });

  for (const s of skillsT.SCHEMAS) {
    const fn = skillsT[s.name];
    if (!fn) continue;
    entries.push({ schema: s, executor: fn });
  }

  // MCP tools.
  const mcpServers = await loadAllMCP();
  for (const server of Object.values(mcpServers)) {
    for (const t of server.tools) {
      entries.push({
        schema: {
          name: t.qualified_name,
          description: `[mcp:${server.name}] ${t.description || ''}`.trim(),
          input_schema: t.inputSchema || t.input_schema || { type: 'object' },
        },
        executor: (args) => server.callTool(t.name, args),
      });
    }
  }

  // De-dup by name — last-wins (native takes priority since it's first? invert to keep first).
  const byName = new Map();
  for (const e of entries) {
    if (!byName.has(e.schema.name)) byName.set(e.schema.name, e);
  }
  const catalog = [...byName.values()];

  return {
    mcpServers,
    tools: catalog.map((e) => e.schema),
    async dispatch(name, input, ctx = {}) {
      const ent = byName.get(name);
      if (!ent) {
        const known = [...byName.keys()];
        // Cheap prefix/substring suggestion.
        const suggestions = known.filter((k) => k.includes(name) || name.includes(k) || k.startsWith(name.slice(0, 3))).slice(0, 3);
        const hint = suggestions.length ? `Did you mean: ${suggestions.join(', ')}?` : `Known tools: ${known.slice(0, 10).join(', ')}…`;
        return { ok: false, error: `unknown_tool: ${name}. ${hint}` };
      }
      try {
        const r = await ent.executor(input, ctx);
        return r ?? { ok: true };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    },
    shutdown() {
      for (const s of Object.values(mcpServers)) s.stop();
    },
  };
}
