/* ─────────────────────────────────────────────────────────────────────────
 * golduck auto-verify + auto-revise (runtime/engine/auto_verify.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * When the model emits an `end_turn` at the end of a complex run, we
 * conditionally invoke `rlm_verify` on the final answer. If the panel
 * returns verdict=revise with high confidence, we feed the issues back
 * as a synthetic user message and let the engine loop once more (bounded
 * to 1 auto-revision per run).
 *
 * Trigger heuristic (objective, so we don't burn budget on trivial turns):
 *   - The run used ≥1 tool round (the model actually did work), OR
 *   - The final text matches a hedge pattern (/i('?m| am) not sure/, etc.)
 *
 * This is the fix Opus suggested in the last self-audit.
 * ───────────────────────────────────────────────────────────────────────── */
import { rlm_verify } from '../tools/rlm.mjs';
import { event } from '../trace/tracer.mjs';

const HEDGE = /\b(i('?m| am) not sure|might be|possibly|i think|not entirely certain|roughly|approximately|i believe|should work|probably)\b/i;
const CLAIMY = /\b(always|never|all|none|every|must|is\s+guaranteed|cannot|will\s+not)\b/i;
const STEPS = /(\n\s*\d+\.\s|\n\s*[-*]\s)/; // numbered/bulleted steps
const AUTO_REVISE_CONFIDENCE_MIN = 0.6;

/**
 * Decide whether the final answer is worth a verify pass.
 *   - Tool rounds → always verify (the model did real work; want quality gate).
 *   - Hedge words → verify (self-flagged uncertainty is a signal).
 *   - "Claimy" absolute language → verify (overclaim risk).
 *   - Structured multi-step response → verify (high blast radius if wrong).
 *   - Trivial short answers are skipped to avoid burn.
 */
export function shouldAutoVerify({ hadToolRounds, finalText }) {
  if (!finalText) return false;
  if (hadToolRounds) return true;
  const t = String(finalText);
  if (HEDGE.test(t)) return true;
  if (t.length >= 200 && CLAIMY.test(t)) return true;
  if (t.length >= 400 && STEPS.test(t)) return true;
  return false;
}

/** Runs the panel verifier. Returns one of:
 *    { kind: 'approve', verdict }
 *    { kind: 'revise',  verdict, injection }  // injection = synthetic user msg
 *    { kind: 'skip',    reason }
 */
export async function autoVerify({ userIntent, finalText, hadToolRounds, budgetRemaining }) {
  if (!shouldAutoVerify({ hadToolRounds, finalText })) {
    return { kind: 'skip', reason: 'trigger_not_met' };
  }
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.5) {
    return { kind: 'skip', reason: 'budget_low' };
  }

  event('auto_verify.start', { hadToolRounds, chars: finalText.length });
  let verdict;
  try {
    verdict = await rlm_verify({ question: userIntent.slice(0, 2000), answer: finalText.slice(0, 20000), model: 'opus' });
  } catch (e) {
    event('auto_verify.error', { msg: String(e) });
    return { kind: 'skip', reason: 'verify_errored' };
  }

  event('auto_verify.verdict', { verdict: verdict?.verdict, confidence: verdict?.confidence });

  if (verdict?.verdict === 'approve') {
    return { kind: 'approve', verdict };
  }
  if (verdict?.verdict !== 'revise') {
    return { kind: 'skip', reason: 'unknown_verdict', verdict };
  }
  if ((verdict.confidence ?? 0) < AUTO_REVISE_CONFIDENCE_MIN) {
    return { kind: 'skip', reason: 'low_confidence', verdict };
  }

  const issues = (verdict.issues || []).map((x) => '- ' + String(x).slice(0, 200)).slice(0, 5).join('\n');
  const fix = String(verdict.suggested_fix || '').slice(0, 2000);
  const injection =
    '[golduck auto-verify] The panel-critic flagged issues with your previous answer. ' +
    'Produce a revised answer that directly addresses them:\n\n' +
    `# Issues\n${issues || '(no explicit list)'}\n\n` +
    `# Suggested fix direction\n${fix || '(none)'}\n\n` +
    '# Original question\n' + userIntent.slice(0, 2000);
  return { kind: 'revise', verdict, injection };
}

/** Re-verify a revised answer against the same question. Returns:
 *    { kind: 'improved',    verdict, prior }
 *    { kind: 'regressed',   verdict, prior }
 *    { kind: 'skip',        reason }
 */
export async function rerunVerify({ userIntent, priorVerdict, revisedText, budgetRemaining }) {
  if (process.env.GOLDUCK_ENFORCE_BUDGET === '1' &&
      budgetRemaining != null && Number.isFinite(budgetRemaining) && budgetRemaining < 0.5) {
    return { kind: 'skip', reason: 'budget_low' };
  }
  let verdict;
  try {
    verdict = await rlm_verify({ question: userIntent.slice(0, 2000), answer: revisedText.slice(0, 20000), model: 'opus' });
  } catch (e) {
    event('rerun_verify.error', { msg: String(e) });
    return { kind: 'skip', reason: 'verify_errored' };
  }
  event('rerun_verify.verdict', { verdict: verdict?.verdict, confidence: verdict?.confidence });
  const priorIssues = (priorVerdict?.issues || []).length;
  const newIssues = (verdict?.issues || []).length;
  if (verdict?.verdict === 'approve') return { kind: 'improved', verdict, prior: priorVerdict };
  if (newIssues < priorIssues)        return { kind: 'improved', verdict, prior: priorVerdict };
  return { kind: 'regressed', verdict, prior: priorVerdict };
}
