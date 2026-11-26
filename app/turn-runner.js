/**
 * One turn of the conversation: the loop that turns a user message into model calls
 * and tool executions, kept out of `app/conversation-manager.js`.
 *
 * The manager owns the *state* (the context window, the usage meter, the pulse, the
 * compaction runner, the tool batch); this module owns the *control flow* of a
 * single turn. Splitting them keeps both modules under the line budget and makes the
 * turn testable against a stub session, exactly like `app/tool-batch.js` made the
 * batch testable without a provider.
 *
 * The session object passed in is the `ConversationManager` — it is the turn's state
 * and the documented seam — and `runTurn()` only calls the members below:
 *
 *   - `contextWindow`        — the chunk window the request is built from
 *   - `getTools()`           — the live tool definitions advertised to the provider
 *   - `getAbortSignal()`     — the active task's signal
 *   - `log(line)`            — the host log
 *   - `notifyContextChange()`— announce the window's stats (the usage meter)
 *   - `notifyRetry(report)`  — a retried provider attempt (a transient notice)
 *   - `notifyNotice(k, t, o)`— any other transient notice
 *   - `beginModelCall()`     — count the call for the model-call pulse, and take the
 *                              prelude messages that ride the request
 *   - `takeInjectedPrompt()` — the prompt a message queued *during this turn* is worth,
 *                              read at the top of the loop so the injection can never
 *                              split a tool batch (task-backlog item 48)
 *   - `callModel(messages, tools, signal, options)` — the provider call itself, so a
 *                              turn can be driven by a stub instead of the network
 *   - `resetPulse(reason)`   — the pulse starts again after a compaction
 *   - `maybeCompact(signal, opts)`  — budget check / forced compaction
 *   - `recordUsage(data, promptTokens)` — token accounting for the answer
 *   - `handleToolCalls(calls, signal)`  — one assistant message's tool batch
 *   - `handleFinalResponse(content)`    — store and print the tool-free reply
 */

import { logEvent } from '../utils/logger.js';
import { announceProse } from './manager-hooks.js';
import {
  APPROACH_REQUIRED_NOTICE,
  APPROACH_SKIPPED_NOTICE,
  approachRefusal,
  isApproachAnnouncement,
  needsApproach,
} from './approach-gate.js';

/** True when a provider failure is an abort in any of the shapes it arrives in. */
export function isAbortFailure(error) {
  return error?.name === 'AbortError'
    || String(error?.message ?? '').toLowerCase().includes('aborted');
}

/**
 * Inject a message the user queued **while this turn was in flight**, if one is waiting.
 *
 * The drain rule is the queue's own (`app/message-queue.js#takeQueuedPrompt`), so the
 * batch order and the verbatim text are identical to the between-turns case; this
 * helper only decides *where* the chunk lands. That place is the top of the per-call
 * loop, which is what keeps a `user` chunk from arriving between an assistant
 * `tool_calls` message and its `tool` results.
 *
 * The injected text is an ordinary user prompt in every respect — one `user` chunk, the
 * same echo the turn's own prompt gets, the autosave event and the meter — so the
 * session record and the transcript show exactly what a message typed a moment later
 * would have produced. It is *new work asked for*, so the caller re-arms the approach
 * gate: the model owes the new message a seed of its own (`docs/agent/approach-gate`).
 *
 * Defensive where it has to be: no queue wired (`takeInjectedPrompt` absent, as in every
 * stub session), nothing queued, or a throwing queue all leave the turn exactly as it
 * was — a missing steer must never cost the user the turn.
 *
 * @returns {boolean} true when a message really landed in the window
 */
function injectQueuedMessage(session, echo) {
  if (typeof session.takeInjectedPrompt !== 'function') return false;
  // Contained here rather than only in the manager: `runTurn()` is driven by any session
  // that implements the seam, and a broken queue must never cost the user their turn.
  let text = '';
  try {
    text = session.takeInjectedPrompt();
  } catch {
    return false;
  }
  if (!String(text ?? '').trim()) return false;
  session.contextWindow.add({ role: 'user', content: text });
  echo('user', text);
  session.notifyChunksChanged?.('injected');
  session.notifyContextChange();
  return true;
}

/**
 * Run one turn: the window is checked before every call, the calls are counted for
 * the pulse, tool batches are executed until a tool-free assistant message arrives,
 * and a recovered failure is a notice while the one that ends the task keeps a line.
 *
 * A message the user queues **while the turn runs** is injected at the top of the loop
 * (`injectQueuedMessage`), so it steers the work without waiting for the turn to end
 * and without splitting an assistant `tool_calls` message from its results.
 *
 * @param {object} session the ConversationManager (see the module doc)
 * @param {string} userInput the turn's prompt
 * @returns {Promise<{ended: 'reply'|'abort'|'error'}>} how the turn ended
 */
export async function runTurn(session, userInput) {
  const { contextWindow } = session;
  // The approach rule (docs/agent/approach-gate): the turn is *addressed* once an
  // assistant message carries prose, and `refusals` counts how many batches this turn
  // has already been refused for arriving before that. A session that declares no bound
  // (`approachMaxRefusals`) is not policed at all, which is what keeps a stub session —
  // and any older wiring — behaving exactly as it did.
  const approachMax = Number(session.approachMaxRefusals) || 0;
  let addressed = false;
  let approachRefusals = 0;
  let skipAnnounced = false;

  contextWindow.add({ role: 'user', content: userInput });
  // The first chunk of a turn is the moment the conversation starts existing on disk:
  // the host writes the session record on this hook (`app/session-autosave.js`), so a
  // turn that dies before it ends still leaves the user's own message behind.
  session.notifyChunksChanged?.('user');
  // The chunk is what the model receives, verbatim; the hook is presentation only.
  // The prose route is tried first, so the TUI can band the echo
  // (docs/interface/prose-bands); a front end without it, and a hook that throws,
  // fall back to the generic `onUserMessage` — a broken renderer must never cost the
  // user their prompt.
  const echo = (role, text) => {
    if (announceProse(session, role, text) != null) return;
    if (typeof session.onUserMessage === 'function') {
      try { session.onUserMessage(text); } catch { /* display only */ }
    }
  };
  echo('user', userInput);
  // The prompt is a chunk too, so the meter moves before the first call is even
  // sent instead of once the whole turn is over.
  session.notifyContextChange();

  while (true) {
    const signal = session.getAbortSignal();

    // A message the user queued while this turn was in flight is injected **here**, at
    // the top of the per-call loop: the one boundary where a `user` chunk can land
    // without splitting an assistant `tool_calls` message from its `tool` results
    // (task-backlog item 48). Injecting it re-arms the approach rule — a steer is a new
    // thing asked for, so the model owes it a seed of its own — and nothing is injected
    // when nothing was queued, so a session with no queue is unchanged.
    if (injectQueuedMessage(session, echo)) {
      addressed = false;
      approachRefusals = 0;
      skipAnnounced = false;
    }

    // Never call the model with an over-budget window. A compaction rewrote the
    // window, so the pulse starts again from 0.
    const compaction = await session.maybeCompact(signal);
    if (compaction?.compacted) session.resetPulse('compaction');

    // Everything the window holds at this instant is about to be sent, so paint
    // exactly that: the meter is current for the call that is sent next.
    session.notifyContextChange();

    try {
      // Count the call about to be sent, and take the line it carries.
      const prelude = session.beginModelCall();
      // What the request is about to cost, measured before it is sent: used only
      // when the provider answers without counters of its own.
      const promptTokens = contextWindow.estimatedTokensWith(prelude);
      // The tools advertised to the provider come from the live registry, not from
      // the manager: a mode can narrow them (see `docs/interface/modes`).
      const data = await session.callModel(
        contextWindow.request(prelude),
        session.getTools(),
        signal,
        { onRetry: (report) => session.notifyRetry(report) },
      );

      // Treat null or empty response as an error and retry.
      if (!data || !data.message) {
        logEvent('warn', 'provider', 'empty response; retrying this turn');
        session.notifyNotice('warn', 'Provider answered with an empty response. Retrying…', { code: 'empty-response' });
        continue;
      }
      session.recordUsage(data, promptTokens);

      if (data.message.tool_calls) {
        // The stated approach seeds the turn: one short statement of intent from which
        // the rest of the work grows. It is enforced here rather than merely instructed
        // to the model, and the prose rides the assistant chunk next to the calls, so it
        // is part of the model's context *and* of the conversation. The seed latches —
        // once a message has carried it, every later batch of the turn is ordinary.
        const prose = isApproachAnnouncement(data.message.content) ? data.message.content : null;
        if (prose) addressed = true;
        if (!addressed && approachMax > 0) {
          if (needsApproach({ announced: false, refusals: approachRefusals, max: approachMax })) {
            approachRefusals += 1;
            logEvent('info', 'approach', 'refusing a batch: the turn has no stated approach', {
              calls: data.message.tool_calls.length,
              refusals: approachRefusals,
              max: approachMax,
            });
            session.notifyNotice('warn', APPROACH_REQUIRED_NOTICE, { code: 'approach-required' });
            // The batch is refused *whole*: every call still owes the provider one
            // result, and each one is the structured body saying what to answer
            // instead. Nothing runs, so no tool can act before the user is addressed.
            await session.handleToolCalls(data.message.tool_calls, signal, {
              content: null,
              gate: () => approachRefusal(),
            });
            continue;
          }
          // The bound is spent. The rule was enforced; the turn must not deadlock on a
          // model that will not speak, so the batch runs and the skip is said once.
          if (!skipAnnounced) {
            skipAnnounced = true;
            logEvent('warn', 'approach', 'the refusal bound is spent; running the batch unannounced', {
              refusals: approachRefusals,
              max: approachMax,
            });
            session.notifyNotice('warn', APPROACH_SKIPPED_NOTICE, { code: 'approach-skipped' });
          }
        }

        const wantsCompaction = await session.handleToolCalls(data.message.tool_calls, signal, { content: prose });
        if (wantsCompaction) {
          const forced = await session.maybeCompact(signal, { force: true, reason: 'tool-request' });
          if (forced?.compacted) session.resetPulse('compaction');
        }
      } else {
        const content = data.message.content;
        await session.handleFinalResponse(content !== undefined && content !== null ? content : '');
        return { ended: 'reply' };
      }
    } catch (error) {
      if (isAbortFailure(error)) {
        logEvent('info', 'provider', 'request aborted; stopping this task', error.message);
        session.log('\n[Info] Request aborted; stopping this task.');
        return { ended: 'abort' };
      }
      // Nothing recovered from this one: it ends the task, so it keeps its
      // transcript line *and* is raised as a notice while the turn winds down.
      // It is also the failure most worth finding in the log afterwards.
      logEvent('error', 'provider', 'provider call failed; ending the turn', error);
      session.notifyNotice('error', session.formatFailure(error), { code: 'provider-failure' });
      session.log(`\nError calling Ollama: ${error.message}`);
      return { ended: 'error' };
    }
  }
}
