import { formatRefusalLine } from './refusal-line.js';

/**
 * The approach announcement: the rule that the prose seeding a turn comes with the calls
 * it introduces.
 *
 * The backlog asks for something the model cannot be trusted to do on its own: "each
 * user message sent must be addressed at least 1 time before calling any tool
 * describing the approach to the next set of operations … this has to be
 * deterministic, not something we expect the model to understand to do on its own".
 *
 * The **seed** is the shape of that: one short statement of what was understood and what
 * the next operations are, written once per turn, from which everything after it grows.
 * It rides the **same** assistant message as the calls it introduces, and it says nothing
 * about order — `isApproachAnnouncement()` reads one message's `content`, and the turn
 * loop latches the first real prose it sees, so every batch after the seed is an ordinary
 * batch. A model cannot tell a "first" answer from a later one, but it *can* see whether
 * it has stated an approach in the conversation in front of it, which is what makes the
 * rule actionable and the defect visible.
 *
 * The deterministic half lives in `app/turn-runner.js`, which reads each assistant
 * message of a turn (`addressed`) and refuses a tool batch whose calls carry no prose
 * only while the turn has no seed. This module is the *policy* it reads, kept apart so the
 * rule, its wording and its bound are values instead of branches buried in the loop:
 *
 *  - `isApproachAnnouncement()` is the whole test — a message whose `content` is real
 *    prose carries the seed, and an empty or blank one asks for tools with what they are
 *    for left unsaid.
 *  - `approachRefusal()` is the structured body stored in each refused call's own
 *    `tool` chunk, so the provider's `tool_call_id` pairing stays balanced and the
 *    model is told *what* to answer instead.
 *  - `needsApproach()` is the bound. A refusal that could repeat forever would let a
 *    stubborn model deadlock the turn, so the host re-asks at most `max` times and then
 *    runs the batch, saying so (`APPROACH_SKIPPED_NOTICE`). The rule is enforced; the
 *    session never stalls.
 *
 * The tool list stays **advertised** while this refuses: the point is not to hide the
 * tools, it is to have the seed say what they are for.
 *
 * Pure: strings in, values out, no window, no provider, no terminal.
 *
 * @see docs/agent/approach-gate
 */

/** Stable result code a call refused for the approach rule carries. */
export const APPROACH_REFUSAL_CODE = 'TOOL_REFUSED_BEFORE_APPROACH';

/** The plain-language reason, shared by the reader's row and the model's body. */
export const APPROACH_REFUSAL_REASON =
  'this turn has no stated approach yet: the prose that seeds a turn comes with the calls '
  + 'it introduces';

/** What the model is told to answer, so the seed is written once and the turn follows it. */
export const APPROACH_REFUSAL_GUIDANCE =
  'Write the seed, in the same message as the calls: what you understood and what the next '
  + 'operations will be. The rest of the turn grows from it and does not repeat it.';

/**
 * The notice asking for the seed. It is *news*, not history: the structured refusal is
 * already in the calls' own chunks, so this floats over the transcript and expires instead
 * of leaving a stale line behind.
 */
export const APPROACH_REQUIRED_NOTICE =
  'The turn has no stated approach: say what you understood and what the next operations are, in the message that carries the calls.';

/** The notice shown when the bound is spent and the batch runs unseeded. */
export const APPROACH_SKIPPED_NOTICE =
  'The model asked for tools with no stated approach again; running the batch anyway.';

/**
 * True when an assistant message carries the turn's seed.
 *
 * Prose is the whole test, so a message that only carries `tool_calls` — the provider
 * shape for a bare call, `content: null` — states nothing, and neither does whitespace.
 */
export function isApproachAnnouncement(content) {
  return typeof content === 'string' && content.trim() !== '';
}

/**
 * The refusal a whole batch gets when the turn has no seed of its own.
 *
 * It is the shape `app/tool-guard.js#guardToolCall` already understands
 * (`{ reason, code, mode, guidance }`), so the batch's refusal path — one `tool` chunk
 * per call, a bright `✖ Refused …` row for the reader — is reused rather than
 * reimplemented (`docs/agent/tool-refusal`).
 */
export function approachRefusal() {
  return {
    reason: APPROACH_REFUSAL_REASON,
    code: APPROACH_REFUSAL_CODE,
    mode: null,
    guidance: APPROACH_REFUSAL_GUIDANCE,
  };
}

/** The reader's row for a call refused for the approach rule. */
export function formatApproachRefusalLine({ name = 'unknown_tool' } = {}) {
  return formatRefusalLine({ name, reason: APPROACH_REFUSAL_REASON });
}

/**
 * Whether the batch arriving right now must be refused for want of a seed.
 *
 * @param {{announced?: boolean, refusals?: number, max?: number}} [state]
 *   `announced` is whether the turn's seed has been written yet, `refusals` how many
 *   times this turn has already been refused for it, `max` the bound.
 */
export function needsApproach({ announced = false, refusals = 0, max = 0 } = {}) {
  if (announced) return false;
  const limit = Number.isFinite(max) && max >= 0 ? Math.floor(max) : 0;
  return refusals < limit;
}
