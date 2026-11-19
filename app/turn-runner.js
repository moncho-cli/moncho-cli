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
 *   - `callModel(messages, tools, signal, options)` — the provider call itself, so a
 *                              turn can be driven by a stub instead of the network
 *   - `resetPulse(reason)`   — the pulse starts again after a compaction
 *   - `maybeCompact(signal, opts)`  — budget check / forced compaction
 *   - `recordUsage(data, promptTokens)` — token accounting for the answer
 *   - `handleToolCalls(calls, signal)`  — one assistant message's tool batch
 *   - `handleFinalResponse(content)`    — store and print the tool-free reply
 */

/** True when a provider failure is an abort in any of the shapes it arrives in. */
export function isAbortFailure(error) {
  return error?.name === 'AbortError'
    || String(error?.message ?? '').toLowerCase().includes('aborted');
}

/**
 * Run one turn: the window is checked before every call, the calls are counted for
 * the pulse, tool batches are executed until a tool-free assistant message arrives,
 * and a recovered failure is a notice while the one that ends the task keeps a line.
 *
 * @param {object} session the ConversationManager (see the module doc)
 * @param {string} userInput the turn's prompt
 * @returns {Promise<{ended: 'reply'|'abort'|'error'}>} how the turn ended
 */
export async function runTurn(session, userInput) {
  const { contextWindow } = session;

  contextWindow.add({ role: 'user', content: userInput });
  // The chunk is what the model receives, verbatim; the hook is presentation only,
  // and a hook that throws must never cost the user their prompt.
  if (typeof session.onUserMessage === 'function') {
    try { session.onUserMessage(userInput); } catch { /* display only */ }
  }
  // The prompt is a chunk too, so the meter moves before the first call is even
  // sent instead of once the whole turn is over.
  session.notifyContextChange();

  while (true) {
    const signal = session.getAbortSignal();

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
        session.notifyNotice('warn', 'Provider answered with an empty response. Retrying…', { code: 'empty-response' });
        continue;
      }
      session.recordUsage(data, promptTokens);

      if (data.message.tool_calls) {
        const wantsCompaction = await session.handleToolCalls(data.message.tool_calls, signal);
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
        session.log('\n[Info] Request aborted; stopping this task.');
        return { ended: 'abort' };
      }
      // Nothing recovered from this one: it ends the task, so it keeps its
      // transcript line *and* is raised as a notice while the turn winds down.
      session.notifyNotice('error', session.formatFailure(error), { code: 'provider-failure' });
      session.log(`\nError calling Ollama: ${error.message}`);
      return { ended: 'error' };
    }
  }
}
