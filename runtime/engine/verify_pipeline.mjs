/* ─────────────────────────────────────────────────────────────────────────
 * golduck verify pipeline (runtime/engine/verify_pipeline.mjs)
 * ─────────────────────────────────────────────────────────────────────────
 * Extracted from the two engines. Drives the full end-of-turn quality
 * loop:
 *
 *   Phase A: rerun-verify if a prior revise landed; roll back on regression.
 *   Phase B: fresh auto-verify; either approve / revise (loop back) / skip.
 *            Chains up to GOLDUCK_MAX_AUTO_REVISIONS times.
 *   Phase C: multi-persona panel-verify when routed.persona has ≥2 entries.
 *   Phase D: best-of-N terminal sampling when reflect = 'deep'.
 *
 * The function is observer-based so CLI (renderer.line) and TUI (store.push)
 * callers can plug in without importing the other's UI layer. All mutation
 * lives on a caller-provided `state` object so the engine's existing
 * bookkeeping (autoRevisions, priorVerdict, priorAnswer, finalAnswer,
 * lastVerify, messages) stays authoritative.
 *
 * Returns { shouldContinue: bool }. When true the caller should `continue`
 * the outer run-loop (a revise was injected). When false, the turn is
 * fully settled.
 * ───────────────────────────────────────────────────────────────────────── */

import { autoVerify, rerunVerify } from './auto_verify.mjs';
import { panelVerify } from './panel_verify.mjs';
import { maybeBestOfN, adaptiveSamples } from './best_of_n.mjs';
import { maybeAutoLesson } from '../memory/lessons.mjs';
import { scheduleFactExtract } from '../memory/fact_extract.mjs';
import { mirrorPriorAnswer, extractUserIntent, maxAutoRevisions } from './core_helpers.mjs';
import { event } from '../trace/tracer.mjs';

/**
 * Run Phase A + Phase B + Phase C + Phase D.
 *
 *   state       — { messages, finalAnswer, autoRevised, autoRevisions,
 *                    priorVerdict, priorAnswer, lastVerify, hadToolRounds,
 *                    usdTotal }
 *   systemBlocks — the engine's current system array (best-of-N needs this).
 *   routed       — the router decision (persona, reflect, model, thinking, max_tokens).
 *   spec         — run spec (budget, etc).
 *   observer     — hooks for UI:
 *                    onRerunImproved({ prior_issues, new_issues, verdict })
 *                    onRerunRegressed({ verdict })
 *                    onReviseQueued({ count, max, issues })
 *                    onReviseCeilingHit({ max })
 *                    onApproved({ confidence })
 *                    onPanelVerdict({ kind, consensus, panel })
 *                    onBestOfNReplaced({ winner, candidates })
 *   The caller must have already produced state.finalAnswer for this turn.
 *
 *   Returns { shouldContinue }. If shouldContinue is true, the outer loop
 *   should NOT drop out — a revise injection has been pushed into
 *   state.messages.
 */
export async function runVerifyPipeline({ state, systemBlocks, routed, spec, observer }) {
  if (spec.verify === 'off') return { shouldContinue: false };

  const maxRevs = maxAutoRevisions();

  // Phase A: rollback-on-regression if a prior revise landed.
  try {
    if (state.autoRevised && state.priorVerdict && state.priorAnswer) {
      try {
        const rv = await rerunVerify({
          userIntent: extractUserIntent(state.messages),
          priorVerdict: state.priorVerdict,
          revisedText: state.finalAnswer,
          budgetRemaining: spec.budget - state.usdTotal,
        });
        if (rv.kind === 'improved') {
          observer?.onRerunImproved?.({
            prior_issues: (state.priorVerdict.issues || []).length,
            new_issues: ((rv.verdict || {}).issues || []).length,
            verdict: rv.verdict,
          });
          state.lastVerify = rv.verdict || state.lastVerify;
          state.priorVerdict = rv.verdict || state.priorVerdict;
          state.priorAnswer = state.finalAnswer;
        } else if (rv.kind === 'regressed') {
          observer?.onRerunRegressed?.({ verdict: rv.verdict });
          state.finalAnswer = state.priorAnswer;
          mirrorPriorAnswer(state.messages, state.priorAnswer);
          state.lastVerify = rv.verdict || state.lastVerify;
        }
      } catch (e) { event('rerun_verify.fatal', { msg: String(e) }); }
    }

    // Phase B: fresh auto-verify against the (possibly-reverted) answer.
    const v = await autoVerify({
      userIntent: extractUserIntent(state.messages),
      finalText: state.finalAnswer,
      hadToolRounds: state.hadToolRounds,
      budgetRemaining: spec.budget - state.usdTotal,
    });
    if (v.verdict) state.lastVerify = v.verdict;
    if (v.kind === 'revise' && state.autoRevisions < maxRevs) {
      state.autoRevisions += 1;
      state.autoRevised = true;
      state.priorVerdict = v.verdict;
      state.priorAnswer = state.finalAnswer;
      observer?.onReviseQueued?.({
        count: state.autoRevisions,
        max: maxRevs,
        issues: (v.verdict.issues || []).length,
        verdict: v.verdict,
      });
      try { maybeAutoLesson({ question: extractUserIntent(state.messages), finalText: state.priorAnswer, verdict: v.verdict }); } catch {}
      state.messages.push({ role: 'user', content: v.injection });
      return { shouldContinue: true };
    } else if (v.kind === 'revise') {
      observer?.onReviseCeilingHit?.({ max: maxRevs });
    } else if (v.kind === 'approve') {
      observer?.onApproved?.({ confidence: v.verdict.confidence, verdict: v.verdict });
      try {
        scheduleFactExtract({
          userIntent: extractUserIntent(state.messages),
          finalAnswer: state.finalAnswer,
          budgetRemaining: spec.budget - state.usdTotal,
        });
      } catch {}
    } else if (v.kind === 'skip' && state.autoRevised) {
      // Even on skip, a prior revise counts as a full verdict for fact-extract.
      try {
        scheduleFactExtract({
          userIntent: extractUserIntent(state.messages),
          finalAnswer: state.finalAnswer,
          budgetRemaining: spec.budget - state.usdTotal,
        });
      } catch {}
    }
  } catch (e) { event('auto_verify.fatal', { msg: String(e) }); }

  // Phase C: multi-persona panel-verify if the router allocated ≥2 personas.
  try {
    const personas = Array.isArray(routed?.persona) ? routed.persona.filter(Boolean) : [];
    if (personas.length >= 2 && state.finalAnswer) {
      const pv = await panelVerify({
        userIntent: extractUserIntent(state.messages),
        finalText: state.finalAnswer,
        routed,
        budgetRemaining: spec.budget - state.usdTotal,
      });
      if (pv && pv.kind) {
        observer?.onPanelVerdict?.({
          kind: pv.kind,
          consensus: pv.consensus,
          panel: pv.panel,
        });
        state.lastVerify = { ...(state.lastVerify || {}), panel: pv.panel, consensus: pv.consensus };
        if (pv.kind === 'revise') {
          try {
            maybeAutoLesson({
              question: extractUserIntent(state.messages),
              finalText: state.finalAnswer,
              verdict: {
                verdict: 'revise',
                issues: (pv.panel || []).flatMap((p) => p.issues || []).slice(0, 6),
              },
            });
          } catch {}
        }
      }
    }
  } catch (e) { event('panel_verify.fatal', { msg: String(e) }); }

  // Phase D: best-of-N terminal sampling (reflect='deep' only).
  try {
    const bon = await maybeBestOfN({
      model: routed.model,
      system: systemBlocks,
      messages: state.messages,
      thinking: routed.thinking,
      max_tokens: routed.max_tokens,
      userIntent: extractUserIntent(state.messages),
      finalAnswer: state.finalAnswer,
      hadToolRounds: state.hadToolRounds,
      budgetRemaining: spec.budget - state.usdTotal,
      reflect: routed.reflect,
      samples: adaptiveSamples(state.lastVerify, 2),
    });
    if (bon && bon.kind === 'replaced' && bon.best && bon.best !== state.finalAnswer) {
      observer?.onBestOfNReplaced?.({ winner: bon.winner, candidates: bon.candidates });
      state.finalAnswer = bon.best;
      mirrorPriorAnswer(state.messages, bon.best);
    } else if (bon && bon.kind === 'kept_original') {
      event('best_of_n.kept_original', {});
    }
  } catch (e) { event('best_of_n.fatal', { msg: String(e) }); }

  return { shouldContinue: false };
}
