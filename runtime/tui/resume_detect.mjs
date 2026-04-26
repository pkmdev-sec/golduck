// resume_detect.mjs — detect a recently-active session worth offering to resume.
//
// Pure ESM, Node built-ins only. Never throws.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveHome(home) {
  if (home) return home;
  return process.env.GOLDUCK_HOME || join(homedir(), '.golduck');
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') parts.push(block);
      else if (typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  return '';
}

function looksLikeError(text) {
  if (!text) return false;
  const trimmed = String(text).trim().toLowerCase();
  return trimmed.startsWith('error:') || trimmed.startsWith('max_turns=');
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant') return extractText(m.content);
  }
  return null;
}

function hasAssistant(messages) {
  return messages.some((m) => m && m.role === 'assistant');
}

export function detectResumeCandidate({ home = null, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  try {
    const dir = join(resolveHome(home), 'state', 'sessions');
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    const now = Date.now();
    let best = null;
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const ageMs = now - st.mtimeMs;
      if (ageMs > maxAgeMs) continue;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        continue;
      }
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
      if (!messages || messages.length === 0) continue;
      if (!hasAssistant(messages)) continue;
      const lastText = lastAssistantText(messages);
      if (looksLikeError(lastText)) continue;
      if (best && st.mtimeMs <= best._mtimeMs) continue;
      best = {
        id: name.slice(0, -'.json'.length),
        updated_at: typeof parsed.updated_at === 'string'
          ? parsed.updated_at
          : new Date(st.mtimeMs).toISOString(),
        message_count: messages.length,
        model: typeof parsed.model === 'string' ? parsed.model : '',
        age_ms: Math.max(0, ageMs),
        _mtimeMs: st.mtimeMs,
      };
    }
    if (!best) return null;
    delete best._mtimeMs;
    return best;
  } catch {
    return null;
  }
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatResumeSuggestion(c) {
  if (!c) return null;
  const age = formatAge(c.age_ms);
  return `resume last session (id=${c.id}, ${c.message_count} msgs, ${age}, /sessions to browse)`;
}
