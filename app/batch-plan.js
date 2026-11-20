import {
  MAX_PARALLEL_TOOL_CALLS,
  TOO_MANY_TOOL_CALLS,
  TOO_MANY_TOOL_CALLS_GUIDANCE,
} from '../config/constants.js';
import { normalizeToolCall } from './tool-call-format.js';

/**
 * Planning one tool batch, and the wording of the refusal a call beyond the cap gets.
 *
 * `app/tool-batch.js` *runs* a batch: it stores the assistant chunk, dispatches the
 * accepted calls together and writes one `tool` chunk per call. Deciding **which** calls
 * that batch is made of, and what a call that does not fit is told, is pure bookkeeping
 * — no window, no tool, no log — so it lives here, next to nothing, and keeps the
 * running half under its line budget.
 *
 * The two halves stay one contract: the cap refusal's body
 * (`formatBatchRefusal()`) and its reader-facing row (`formatBatchRefusalReason()`) are
 * written from the same string, so the model and the reader can never be told different
 * things (`docs/agent/tool-refusal`).
 *
 * Re-exported from `app/tool-batch.js`, so every existing import keeps working.
 */

/** The plain-language reason a cap refusal carries, shared by the row and the JSON. */
export function formatBatchRefusalReason({ requested = 0, max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  return `this message asked for ${requested} tool calls at once; only ${max} run in a batch`;
}

/** A call a batch refused to run because the message asked for too many. */
export function formatBatchRefusal({ name, requested, max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  return JSON.stringify({
    status: 'error',
    code: TOO_MANY_TOOL_CALLS,
    tool: name,
    guidance: TOO_MANY_TOOL_CALLS_GUIDANCE,
    message: formatBatchRefusalReason({ requested, max }),
    max,
  }, null, 2);
}

/**
 * Split the calls of one assistant message into the batch that runs and the calls
 * that are refused, preserving the model's order in both.
 *
 * A call is accepted by **position**, never by name: the first `max` ids keep the
 * pairing with the results the provider expects, and the remainder are answered
 * with a refusal instead of being dropped.
 *
 * @returns {{accepted: object[], refused: object[], total: number, max: number, simultaneous: boolean}}
 */
export function planToolBatch(toolCalls = [], { max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_PARALLEL_TOOL_CALLS;
  const accepted = [];
  const refused = [];

  list.forEach((call, index) => {
    const entry = { index, call: normalizeToolCall(call, index) };
    (index < limit ? accepted : refused).push(entry);
  });

  return {
    accepted,
    refused,
    total: list.length,
    max: limit,
    simultaneous: accepted.length > 1,
  };
}

/** The line announcing a batch before its calls run (a lone call needs none). */
export function formatBatchLine({ accepted = 0, refused = 0, max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  const parts = [`${accepted} call(s) at once (max ${max})`];
  if (refused > 0) parts.push(`${refused} refused: ${TOO_MANY_TOOL_CALLS}`);
  return `  -> batch: ${parts.join(' · ')}`;
}
