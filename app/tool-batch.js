import { MAX_PARALLEL_TOOL_CALLS } from '../config/constants.js';
import { detectCompactionRequest } from './compaction-request.js';
import { guardToolCall, formatGuardRefusal } from './tool-guard.js';
import { formatRefusalLine } from './refusal-line.js';
import { logEvent } from '../utils/logger.js';
import { captureIds, expireCaptures, capturesRequestedBy } from '../utils/capture-store.js';
import {
  formatCallLines,
  formatCallSignature,
  formatToolResultChunk,
} from './tool-call-format.js';
// The pure half of a batch — which calls it is made of, and what a call beyond the cap
// is told — lives in app/batch-plan.js so this module stays the *running* half. Both are
// re-exported below, so every existing import of these names keeps working.
import {
  formatBatchLine,
  formatBatchRefusal,
  formatBatchRefusalReason,
  planToolBatch,
} from './batch-plan.js';

export { formatBatchLine, formatBatchRefusal, formatBatchRefusalReason, planToolBatch };

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
      outcome.refusal = refusal;
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
      // The failure becomes an `[error]` chunk so the model can react to it; the
      // log keeps the stack, which the chunk does not carry.
      logEvent('warn', 'tool', `tool ${name} threw`, error);
      outcome.isError = true;
      outcome.result = `Error executing ${name}: ${error.message}`;
    }
    return outcome;
  }));
}

/**
 * One stored `tool` chunk: the call's intent, then the result inside the batch
 * envelope that names the call's signature and the size of the batch.
 */
function batchChunk({ call, result, isError, calls }) {
  return formatToolResultChunk({
    intent: call.storedIntent !== undefined ? call.storedIntent : call.intent,
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
  content = null,
  logProse = null,
} = {}) {
  const plan = planToolBatch(toolCalls, { max });
  const notifyChange = typeof notify === 'function' ? notify : () => {};
  // The prose route (docs/interface/prose-bands): prose next to the calls is piped
  // through it so a front end can band it, and anything other than a real return
  // (no hook, a throwing one) falls back to the generic log.
  const proseLog = typeof logProse === 'function' ? logProse : () => null;
  let lastStoredIntent = null;
  let lastLoggedIntent = null;

  // Emit a single, OpenAI-compatible assistant chunk carrying all tool calls.
  // `content` is the prose the model wrote next to them: keeping it on the *same*
  // chunk is what puts an announced approach in the model's context (the provider
  // shape pairs prose and calls in one message) and in the reader's transcript, and
  // it is why nothing has to be duplicated into a second message.
  window?.add({
    role: 'assistant',
    content: content ?? null,
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

  // The model's own words next to its calls are printed *before* the calls they
  // introduce, so the reader sees the approach that was stated — the same prose the
  // assistant chunk carries for the model (`docs/agent/approach-gate`).
  if (typeof content === 'string' && content.trim() !== '') {
    if (proseLog('assistant', content) == null) log(content);
  }

  if (plan.total > 1) {
    log(formatBatchLine({ accepted: plan.accepted.length, refused: plan.refused.length, max: plan.max }));
  }

  // Every call of the batch is announced before any of them runs: they are in
  // flight together, so printing them one per completion would misreport the
  // batch as a chain. The call's shape (name, parsed args, intent) comes from the
  // shared formatter, so the printed lines and the replay agree by construction.
  for (const { call } of plan.accepted) {
    const callLines = formatCallLines(call);
    // Deduplicate intent: skip the intent line if it matches the previous call's intent
    if (call.intent === lastLoggedIntent) {
      log(callLines[0]); // Only log the "-> Calling ..." line
    } else {
      for (const line of callLines) log(line);
      lastLoggedIntent = call.intent;
    }
  }

  // The accepted calls are dispatched together and awaited together, so their
  // wall-clock cost is the slowest call rather than the sum of all of them.
  const existingCaptures = captureIds();
  const outcomes = await dispatchToolCalls(plan.accepted, toolFunctions, { signal, gate });
  // A capture lives for one action (docs/agent/command-capture): the ones that already
  // existed and that this batch did not ask to read go now, so a huge output can never
  // pile up in memory. A capture *taken* during the batch is kept — the next batch may
  // read it, which is what makes "inspect it next" possible.
  const keptByCallers = capturesRequestedBy(plan.accepted.map(({ call }) => call));
  const takenNow = captureIds().filter((id) => !existingCaptures.includes(id));
  expireCaptures({ keep: [...takenNow, ...keptByCallers] });
  let compactionRequested = false;
  const order = [];

  for (const outcome of outcomes) {
    if (detectCompactionRequest(outcome.result)) compactionRequested = true;

    // The intent is part of the tool result chunk, so it stays in the model's
    // context (task.md item 6) instead of only being printed to the terminal.
    // Deduplicate: if intent matches previously stored intent, store with empty intent to avoid repetition
    const storedIntent = outcome.intent === lastStoredIntent ? '' : outcome.intent;
    window?.add({
      role: 'tool',
      tool_call_id: outcome.id,
      content: batchChunk({
        call: { ...outcome, storedIntent },
        result: outcome.result,
        isError: outcome.isError,
        calls: plan.total,
      }),
    });
    // A refused call is news: one line to the reader, the structured refusal to the model.
    if (outcome.refused) log(formatRefusalLine({ name: outcome.name, ...outcome.refusal }));
    lastStoredIntent = outcome.intent;
    // One tool result, one chunk: a long chain of calls then shows the usage
    // climbing call by call instead of jumping once the turn ends.
    notifyChange();
    order.push(outcome.id);
  }

  // A call beyond the cap is answered, never dropped: the provider pairs one
  // result per call id, so a missing chunk would leave the message unbalanced.
  for (const { call } of plan.refused) {
    lastLoggedIntent = null;
    lastStoredIntent = null; // Reset for refused calls
    log(formatRefusalLine({ name: call.name, reason: formatBatchRefusalReason({ requested: plan.total, max: plan.max }) }));
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