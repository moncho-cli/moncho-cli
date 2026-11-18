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
  const tokens =
    lastCompaction.olderTokens != null && lastCompaction.afterTokens != null
      ? ` (${lastCompaction.olderTokens} -> ${lastCompaction.afterTokens} tokens)`
      : '';
  return `[Context] compaction fired: ${older} older chunk(s) -> summary, kept ${kept} newest chunk(s)${tokens}.`;
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
    /** How many compactions have been announced so far. */
    get announced() {
      return marks;
    },
  };
}
