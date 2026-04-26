/* Inline verify — calls rlm_verify synchronously after the main engine
 * response. Opus 4.7 only. */
import * as rlmT from '../tools/rlm.mjs';

export async function scheduleVerifyInline({ question, answer, routed }) {
  return rlmT.rlm_verify({ question, answer, model: 'opus' });
}
