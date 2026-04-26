/* ─────────────────────────────────────────────────────────────────────────
 * golduck TUI ↔ engine verify bridge (runtime/tui/verify_bridge.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Thin, user-triggered orchestration around `scheduleVerifyInline` from
 * runtime/verify/inline.mjs. Unlike runtime/engine/auto_verify.mjs (which
 * runs automatically post-turn based on heuristics), this bridge is wired
 * into the `/verify` slash command so the user can force a panel-verify
 * on the last turn.
 *
 * Contract:
 *   - Pure ESM, no React, no new deps.
 *   - Never throws; returns null on any failure and pushes an event.
 *   - All store interactions go through `store.push(kind, payload)` to
 *     match the contract documented in runtime/tui/store.mjs.
 * ───────────────────────────────────────────────────────────────────────── */
import { scheduleVerifyInline } from '../verify/inline.mjs';

function safePush(store, kind, payload) {
  if (!store || typeof store.push !== 'function') return;
  try { store.push(kind, payload); } catch { /* ignore bad store */ }
}

function extractAssistantText(msg) {
  if (!msg) return '';
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractUserText(msg) {
  if (!msg) return '';
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export async function runInlineVerify({ question, answer, routed, store } = {}) {
  const q = typeof question === 'string' ? question.trim() : '';
  const a = typeof answer === 'string' ? answer.trim() : '';
  if (!q || !a) {
    safePush(store, 'notice', {
      kind: 'warn',
      message: 'verify: missing question or answer; skipping.',
    });
    return null;
  }

  let verdict;
  try {
    verdict = await scheduleVerifyInline({ question: q, answer: a, routed: routed || {} });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    safePush(store, 'verify', { verdict: 'error', issues: [message] });
    return null;
  }

  if (!verdict || typeof verdict !== 'object') {
    safePush(store, 'verify', {
      verdict: 'error',
      issues: ['verifier returned no verdict'],
    });
    return null;
  }

  const payload = {
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    issues: Array.isArray(verdict.issues) ? verdict.issues : [],
  };
  safePush(store, 'verify', payload);
  return payload;
}

export async function forceVerifyLastTurn({ store, messages, routed } = {}) {
  const list = Array.isArray(messages) ? messages : [];

  let lastUser = null;
  let lastAssistant = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || !m.role) continue;
    if (!lastAssistant && m.role === 'assistant') lastAssistant = m;
    else if (!lastUser && m.role === 'user') lastUser = m;
    if (lastUser && lastAssistant) break;
  }

  const question = extractUserText(lastUser);
  const answer = extractAssistantText(lastAssistant);

  if (!question || !answer) {
    safePush(store, 'notice', {
      kind: 'warn',
      message: 'verify: no prior turn found to verify.',
    });
    return null;
  }

  return runInlineVerify({ question, answer, routed: routed || {}, store });
}
