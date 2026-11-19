/**
 * The pre-dispatch gate every tool call passes before it is allowed to run.
 *
 * `app/tool-batch.js` dispatches a whole assistant message at once, so the one
 * place that can refuse a call *before* it touches anything is the dispatch
 * itself. This module is that seam: `dispatchToolCalls()` asks the gate about each
 * call, and a gate that answers with a refusal turns the call into a structured
 * `[error]` outcome instead of invoking the tool.
 *
 * The gate is injected, never imported: the batch keeps working with no gate at
 * all (`allowAllGate`), and the mode rules (`docs/interface/modes`: Chat is
 * read-only, Design writes the tracking files only, Work is unrestricted) plug in
 * as one function without the batch knowing what a mode is.
 *
 * Keeping the gate here rather than inline in the batch is what keeps
 * `app/tool-batch.js` under its line budget, and it makes the refusal a pure,
 * testable value instead of a branch buried in an async map.
 */

/** A refusal code for a call the session's mode does not allow to run. */
export const TOOL_GUARD_REFUSAL = 'TOOL_REFUSED_BY_MODE';

/**
 * The gate that refuses nothing.
 *
 * The batch must work exactly as before when nobody installed a gate, so this is
 * the default: `null` means "allowed", and the batch's own checks (abort, unknown
 * tool, a throwing tool) stay exactly where they were.
 */
export function allowAllGate() {
  return null;
}

/**
 * Ask the gate about one call.
 *
 * The gate receives the normalized call (`{ id, name, args, rawArgs, intent }`)
 * and answers `null`/`undefined`/`false`/`true` to allow the call, or an object
 * describing the refusal (`{ reason, code?, mode?, guidance? }`). Any other value
 * is a refusal with a generic reason, so a buggy gate fails closed.
 *
 * @param {object} call the normalized tool call
 * @param {Function|null} [gate] the installed gate
 * @returns {null|{reason: string, code: string, mode: string|null, guidance: string|undefined}}
 */
export function guardToolCall(call, gate = null) {
  if (typeof gate !== 'function') return null;
  let answer;
  try {
    answer = gate(call);
  } catch (error) {
    // A gate that throws must not run the tool: failing closed is the only safe
    // reading of "the policy could not decide".
    return {
      reason: `the tool gate failed: ${error.message}`,
      code: TOOL_GUARD_REFUSAL,
      mode: null,
      guidance: 'The call was not executed because the session policy could not be evaluated.',
    };
  }
  if (answer === null || answer === undefined || answer === false) return null;
  if (answer === true) return null;
  return {
    reason: answer.reason || 'the current mode does not allow this call',
    code: answer.code || TOOL_GUARD_REFUSAL,
    mode: answer.mode ?? null,
    guidance: answer.guidance,
  };
}

/**
 * The body a refused call gets in place of its result.
 *
 * It is JSON with a `code`, the tool's name, the mode that refused it and a
 * `guidance` line, exactly like the batch's own `TOO_MANY_TOOL_CALLS` refusal: the
 * model is told *what* happened and *why*, and can adapt instead of retrying the
 * same call. It is stored as an `[error]` chunk, so the provider still gets one
 * result per call id.
 */
export function formatGuardRefusal({ name, reason, code = TOOL_GUARD_REFUSAL, mode = null, guidance } = {}) {
  return JSON.stringify({
    status: 'error',
    code,
    tool: name ?? null,
    mode,
    message: `${name ?? 'the call'} was not executed: ${reason ?? 'the current mode does not allow it'}.`,
    guidance: guidance || 'Answer with what the current mode allows, or switch mode if the user meant to change files.',
  }, null, 2);
}