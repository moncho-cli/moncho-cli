/**
 * The one-line notice the TUI prints when the context window is compacted.
 *
 * A compaction fires while a request is in flight — exactly when the status
 * bar's left slot is owned by the spinner — so the marker has to go to the
 * transcript to be visible right away. The window's stats carry a compaction
 * *history*, so the notice is emitted **once per event** and never twice for the
 * same entry (see `docs/interface/tui`).
 *
 * The text is built purely, so the wording is unit testable without a terminal.
 */

/** The transcript line announcing a compaction. */
export function formatCompactionNotice(lastCompaction = {}) {
  const older = Number(lastCompaction.olderChunks) || 0;
  const kept = Number(lastCompaction.keptChunks) || 0;
  // The user's own message is re-inserted verbatim after the summary, so the
  // marker says so: it is the one chunk of the evicted block that was not
  // paraphrased (`utils/compaction.js`).
  const carried = Number(lastCompaction.carriedChunks) > 0 ? ', last user message carried' : '';
  const tokens =
    lastCompaction.olderTokens != null && lastCompaction.afterTokens != null
      ? ` (${lastCompaction.olderTokens} -> ${lastCompaction.afterTokens} tokens)`
      : '';
  return `[Context] compaction fired: ${older} older chunk(s) -> summary, kept ${kept} newest chunk(s)${carried}${tokens}.`;
}

/**
 * Bind the notice to a transcript logger. `notify(stats)` announces a *new*
 * compaction and stays silent when the history has not grown.
 */
export function createCompactionNotifier({ log } = {}) {
  let marks = 0;

  return {
    notify(stats) {
      const count = Number(stats?.compactions) || 0;
      if (count <= marks) return null;
      marks = count;
      const line = formatCompactionNotice(stats?.lastCompaction || {});
      if (typeof log === 'function') log(line);
      return line;
    },
    /**
     * Forget what has been announced, so the *next* compaction is reported.
     * Needed when the transcript is replaced (a resumed session): the events the
     * counter tracked are no longer on screen.
     */
    reset() {
      marks = 0;
    },
    /** How many compactions have been announced so far. */
    get announced() {
      return marks;
    },
  };
}
