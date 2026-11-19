import {
  MAX_PARALLEL_TOOL_CALLS,
  TOO_MANY_TOOL_CALLS,
  TOO_MANY_TOOL_CALLS_GUIDANCE,
} from '../config/constants.js';
import { detectCompactionRequest } from './compaction-request.js';
import { guardToolCall, formatGuardRefusal } from './tool-guard.js';
import {
  formatCallLines,
  formatCallSignature,
  formatToolResultChunk,
  normalizeToolCall,
} from './tool-call-format.js';

/**
 * One tool batch: the calls of a single assistant message.
 *
 * A model can answer with several `tool_calls` at once — five reads, a grep and a
 * blob, a set of independent probes. Running them one after another wastes the
 * whole point of the request, so this module plans the batch, dispatches it
 * simultaneously and collects the results **in the order the model asked for**,
 * not in completion order.
 *
 * The cap (`MAX_PARALLEL_TOOL_CALLS`) is what keeps a runaway batch bounded: the
 * first N calls run and every call beyond it is answered with a structured
 * `TOO_MANY_TOOL_CALLS` refusal, so the assistant message still gets one result
 * per call id (the provider pairs them) and the model is told to ask smaller.
 *
 * Pure planning, injected execution: `planToolBatch()` and `formatBatchRefusal()`
 * are pure, `dispatchToolCalls()` takes the tool map as an argument, and
 * `handleToolBatch()` takes the window, the log and the notify hook — so the
 * whole batch is unit testable without a provider.
 *
 * The chunk shape lives in `app/tool-call-format.js`: one `tool` chunk per call,
 * the intent first and the result inside the `<tool-multicall result>` envelope
 * (`docs/agent/tool-multicall`).
 */

/** A call a batch refused to run because the message asked for too many. */
export function formatBatchRefusal({ name, requested, max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  return JSON.stringify({
    status: 'error',
    code: TOO_MANY_TOOL_CALLS,
    tool: name,
    guidance: TOO_MANY_TOOL_CALLS_GUIDANCE,
    message: `This message asked for ${requested} tool calls at once; only ${max} run in a batch.`,
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

/**
 * Run the accepted calls **at the same time** and return their outcomes in call
 * order.
 *
 * Each entry resolves to `{ id, name, signature, result, isError, succeeded }`; a
 * throwing tool never rejects the batch, it becomes an `isError` outcome (exactly
 * the behaviour the sequential loop had). An aborted task skips the remaining
 * calls instead of starting work for a request the user already cancelled.
 */
export async function dispatchToolCalls(entries = [], toolFunctions = {}, { signal = null, gate = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];

  return Promise.all(list.map(async ({ call }) => {
    const { name, args, rawArgs, intent, id } = call;
    const outcome = {
      id,
      name,
      args,
      rawArgs,
      intent,
      signature: formatCallSignature({ name, args }),
      result: null,
      isError: false,
      succeeded: false,
    };

    if (signal?.aborted) {
      outcome.isError = true;
      outcome.result = `Error executing ${name}: the task was cancelled before the call started.`;
      return outcome;
    }

    // The pre-dispatch gate (app/tool-guard.js): the only place a call can be
    // refused *before* it touches anything. Without a gate this is a no-op, so
    // the batch behaves exactly as it did before the modes existed.
    const refusal = guardToolCall({ id, name, args, rawArgs, intent }, gate);
    if (refusal) {
      outcome.isError = true;
      outcome.refused = true;
      outcome.result = formatGuardRefusal({ name, ...refusal });
      return outcome;
    }

    const run = toolFunctions[name];
    if (typeof run !== 'function') {
      outcome.isError = true;
      outcome.result = `Error executing ${name}: unknown tool.`;
      return outcome;
    }

    try {
      outcome.result = await run(rawArgs);
      outcome.succeeded = true;
    } catch (error) {
      outcome.isError = true;
      outcome.result = `Error executing ${name}: ${error.message}`;
    }
    return outcome;
  }));
}

/** The line announcing a batch before its calls run (a lone call needs none). */
export function formatBatchLine({ accepted = 0, refused = 0, max = MAX_PARALLEL_TOOL_CALLS } = {}) {
  const parts = [`${accepted} call(s) at once (max ${max})`];
  if (refused > 0) parts.push(`${refused} refused: ${TOO_MANY_TOOL_CALLS}`);
  return `  -> batch: ${parts.join(' · ')}`;
}

/**
 * One stored `tool` chunk: the call's intent, then the result inside the batch
 * envelope that names the call's signature and the size of the batch.
 */
function batchChunk({ call, result, isError, calls }) {
  return formatToolResultChunk({
    intent: call.intent,
    signature: formatCallSignature({ name: call.name, args: call.args }),
    result,
    isError,
    calls,
  });
}

/**
 * Handle one assistant message's tool calls end to end: append the assistant
 * chunk, run the batch, and store one `tool` chunk per call (in call order).
 *
 * The window, the log and the notify hook are passed in, so the same code drives
 * the live loop and a test. Every result is stored inside the multicall envelope
 * carrying the call's signature; a refused call is stored as an `[error]` body
 * with the same signature, so the model sees *which* call was dropped.
 *
 * @returns {Promise<{compactionRequested: boolean, executed: number, refused: number, order: string[]}>}
 */
export async function handleToolBatch({
  toolCalls = [],
  signal = null,
  window = null,
  log = () => {},
  toolFunctions = {},
  max = MAX_PARALLEL_TOOL_CALLS,
  notify = () => {},
  gate = null,
} = {}) {
  const plan = planToolBatch(toolCalls, { max });
  const notifyChange = typeof notify === 'function' ? notify : () => {};

  // Emit a single, OpenAI-compatible assistant chunk carrying all tool calls.
  window?.add({
    role: 'assistant',
    content: null,
    tool_calls: plan.accepted.concat(plan.refused).map(({ call }) => ({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: typeof call.rawArgs === 'string' ? call.rawArgs : JSON.stringify(call.rawArgs ?? {}),
      },
    })),
  });
  // The assistant chunk carrying the calls is a chunk like any other.
  notifyChange();

  if (plan.total > 1) {
    log(formatBatchLine({ accepted: plan.accepted.length, refused: plan.refused.length, max: plan.max }));
  }

  // Every call of the batch is announced before any of them runs: they are in
  // flight together, so printing them one per completion would misreport the
  // batch as a chain. The call's shape (name, parsed args, intent) comes from the
  // shared formatter, so the printed lines and the replay agree by construction.
  for (const { call } of plan.accepted) {
    for (const line of formatCallLines(call)) log(line);
  }

  // The accepted calls are dispatched together and awaited together, so their
  // wall-clock cost is the slowest call rather than the sum of all of them.
  const outcomes = await dispatchToolCalls(plan.accepted, toolFunctions, { signal, gate });
  let compactionRequested = false;
  const order = [];

  for (const outcome of outcomes) {
    if (detectCompactionRequest(outcome.result)) compactionRequested = true;

    // The intent is part of the tool result chunk, so it stays in the model's
    // context (task.md item 6) instead of only being printed to the terminal.
    window?.add({
      role: 'tool',
      tool_call_id: outcome.id,
      content: batchChunk({
        call: outcome,
        result: outcome.result,
        isError: outcome.isError,
        calls: plan.total,
      }),
    });
    // One tool result, one chunk: a long chain of calls then shows the usage
    // climbing call by call instead of jumping once the turn ends.
    notifyChange();
    order.push(outcome.id);
  }

  // A call beyond the cap is answered, never dropped: the provider pairs one
  // result per call id, so a missing chunk would leave the message unbalanced.
  for (const { call } of plan.refused) {
    log(`\n  -> Refused ${call.name} (beyond the batch of ${plan.max})`);
    window?.add({
      role: 'tool',
      tool_call_id: call.id,
      content: batchChunk({
        call,
        result: formatBatchRefusal({ name: call.name, requested: plan.total, max: plan.max }),
        isError: true,
        calls: plan.total,
      }),
    });
    notifyChange();
    order.push(call.id);
  }

  return {
    compactionRequested,
    executed: outcomes.length,
    // How many of the executed calls the mode gate refused (app/tool-guard.js);
    // they still got a result chunk, but no tool ran for them.
    guarded: outcomes.filter((outcome) => outcome.refused).length,
    refused: plan.refused.length,
    simultaneous: plan.simultaneous,
    order,
  };
}
