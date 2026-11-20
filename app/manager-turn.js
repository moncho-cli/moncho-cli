import { handleToolBatch } from './tool-batch.js';
import { announceProse } from './manager-hooks.js';

/**
 * The two steps one turn takes on the conversation, kept out of the class.
 *
 * `app/turn-runner.js` drives a turn by calling the `ConversationManager`; two of those
 * calls *do* something rather than report something, and both are wiring over a module
 * that already exists:
 *
 *  - `runToolBatch()` is the tool batch of one assistant message
 *    (`app/tool-batch.js`, `docs/agent/tool-multicall`), timed as one *tool* span —
 *    the calls run at the same time, so timing them one by one would report the sum of
 *    a parallel batch instead of how long the user waited for it.
 *  - `storeFinalResponse()` is the tool-free reply that ends a turn: the chunk, the
 *    `[Context]` line the line CLI reads, and the two announcements the host needs
 *    (`docs/context/usage-refresh`).
 *
 * Keeping them here is what lets the manager stay the *state* — window, meter, pulse,
 * clock, tool map — with the two side effects delegated.
 */

/**
 * Run the tool calls of one assistant message as a batch.
 *
 * Two options come from the turn loop: `content` is the prose the model wrote **next
 * to** its calls, stored on the same assistant chunk, which is what keeps an announced
 * approach in the context (`docs/agent/approach-gate`); `gate` overrides the session
 * gate for this one batch, so the approach rule can refuse a whole batch without the
 * manager knowing what an approach is.
 *
 * @returns {Promise<boolean>} true when a tool asked for a deferred compaction.
 */
export async function runToolBatch(host, toolCalls, signal, options = {}) {
  const span = host.working.begin('tool');
  try {
    const report = await handleToolBatch({
      toolCalls,
      signal,
      window: host.contextWindow,
      toolFunctions: host.toolFunctions,
      log: (line) => host.log(line),
      notify: () => host.notifyContextChange(),
      gate: options.gate ?? host.toolGate,
      content: options.content ?? null,
      // The prose next to the calls is banded like the final reply, so both halves of
      // "what the agent wrote" read the same (docs/interface/prose-bands).
      logProse: (role, text) => announceProse(host, role, text),
      ...(host.maxParallelToolCalls ? { max: host.maxParallelToolCalls } : {}),
    });
    host.lastBatch = report;
    // An assistant chunk plus one chunk per call land in the same tick, so the record
    // is written once for the whole batch (`app/session-autosave.js`).
    host.notifyChunksChanged('tools');
    return report.compactionRequested;
  } finally {
    host.recordWorkTime({ kind: 'tool', ms: host.working.end(span) });
  }
}

/**
 * Store the reply that ends a turn, print it, and announce it.
 *
 * The reply is a chunk like any other, so it is saved and metered; the delimiters are
 * the display the line CLI and the replay share (`app/session-replay.js`).
 */
export function storeFinalResponse(host, content) {
  host.contextWindow.add({ role: 'assistant', content });
  host.notifyChunksChanged('reply');
  host.notifyContextChange();

  // The reply is one side of the dialogue, so it is printed on the prose route: a
  // front end with a band paints it on one (docs/interface/prose-bands), and without
  // one — or with a hook that throws — the line is exactly what it always was. The
  // delimiters stay chrome: they are the frame around the band, not part of it.
  const prose = (text) => {
    if (announceProse(host, 'assistant', text) != null) return;
    host.log(text);
  };

  host.log('\n--- AI Response ---');
  prose(content);
  host.log('----------------------');
  host.log(`[Context] ${host.contextWindow.usage()}\n`);
}
