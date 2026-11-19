import { callOllama } from '../api/ollama.js';
import { estimateMessagesTokens } from '../utils/tokens.js';

/**
 * The compaction step of the conversation loop.
 *
 * Extracted from `app/conversation-manager.js` so the manager keeps its shape as
 * the pulse (task-backlog: "keep in the context an incremental pulse on each model
 * call") added another responsibility to it. Behaviour is unchanged: the window is
 * compacted when it exceeds its budget or when a tool forced it, the summariser call
 * opts out of the agent system prompt, and a failure leaves the window untouched and
 * never breaks the task (`docs/context/compaction`).
 *
 * The provider connection stays with the caller: `callModel` is injected, so this
 * module owns the *sequencing* (compact, report, notify) and nothing else, and it is
 * testable with a window stub and no network.
 *
 * @param {object} deps
 * @param {object} deps.window          the live ContextWindow
 * @param {Function} deps.callModel     `(messages, ctx) => Promise<string>` summary
 * @param {Function} [deps.log]         transcript line sink
 * @param {Function} [deps.notify]      called after the window was rewritten
 */
export function createCompactionRunner({ window, callModel, log = () => {}, notify = () => {} } = {}) {
  return {
    /** See `ConversationManager#maybeCompact`. Returns the compaction report. */
    async run(signal, { force = false, reason = 'over-budget' } = {}) {
      if (!force && !window.needsCompaction()) return null;

      // The compaction is announced *before* it runs: the summariser call takes
      // time, so the conversation thread must say that something is happening
      // instead of going quiet until the window has been rewritten.
      log(`\n[Context] Compaction process started...`);

      try {
        const result = await window.compact({ force, reason, signal, callModel });

        if (result.compacted) {
          log(`\n[Context] Compacted ${result.olderChunks} older chunk(s) into a summary (${result.olderTokens} -> ${result.afterTokens} tokens).`);
          log(`[Context] Window: ${result.usage}`);
          // The window was rewritten underneath the chunks, so the meter has to be
          // repainted with the smaller number straight away.
          notify();
        }
        return result;
      } catch (error) {
        // A failed compaction must never break the task; the window is unchanged.
        log(`\n[Context] Compaction skipped: ${error.message}`);
        return { compacted: false, reason: 'error', error: error.message };
      }
    },
  };
}

/**
 * The summariser call for `compact_context`: a provider call like any other, so it
 * is metered and billed against the answering model — but a **neutral** one, because
 * `systemPrompt: false` keeps the summariser from answering as the agent.
 *
 * @param {(response: object, promptTokens: number) => void} meter records the call
 */
export function createSummaryCallModel({ meter = () => {} } = {}) {
  return async (messages, ctx = {}) => {
    const promptTokens = estimateMessagesTokens(messages);
    const response = await callOllama(messages, [], false, ctx.signal, { systemPrompt: false });
    meter(response, promptTokens);
    return response?.message?.content ?? '';
  };
}
