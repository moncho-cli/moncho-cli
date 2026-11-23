/**
 * The transcript announcement of an item collapse (`docs/interface/collapse-notice`).
 *
 * A collapse replaces a solved item's whole section with one summary
 * (`docs/context/item-collapse`) and keeps its raw chunks in a chunkpaction capture
 * (`docs/context/chunkpaction`). Until now only the *model* was told: the collapse report
 * rides back in `update_task`'s JSON reply, which never reaches the transcript. The user,
 * who watches the conversation, saw the window shrink with no explanation.
 *
 * This module turns one collapse into the one `[Context]` line printed instead — the
 * prefix the compaction lines already use, so `app/theme.js` colours it with no new rule
 * and the two context events read as the same family.
 *
 * **One line, not a start/end pair.** A compaction logs `Compaction process started...`
 * and then `Compacted N older chunk(s)…`, and the first of those exists for a real
 * reason: the summariser call takes seconds, so the thread must not go quiet
 * (`app/compaction-runner.js`). A collapse is a synchronous array rewrite that takes
 * microseconds — there is no gap for a start line to fill, and announcing one would be
 * noise about nothing, the same reason a tool call does not announce itself twice.
 *
 * Pure: `formatCollapseNotice()` builds the text and `createCollapseNotifier()` binds it
 * to a logger, so the wording is unit tested without a terminal. Presentation only —
 * these lines never reach the model context or a session file.
 */

/** Every announcement line starts with this, which is what colours it. */
export const COLLAPSE_NOTICE_PREFIX = '[Context]';

/** Quote one piece of model text, flattened to a single line so a row cannot break. */
function quoted(text) {
  return JSON.stringify(String(text ?? '').replace(/\s+/g, ' ').trim());
}

/** The plural-aware noun of a count: `1 chunk`, `3 chunks`. */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The lines one collapse prints: one per collapsed item, in the order they were collapsed.
 *
 * The capture id is in the line on purpose: it is what makes the summary's pointer
 * followable *and* what a human can hand back to the agent ("read capture 2"), so the
 * announcement is also the receipt for where the raw chunks went.
 *
 * @param {{collapsed?: object[], chunks?: number}} report what `runItemCollapse` returned
 * @returns {string[]} zero or more `[Context] …` lines
 */
export function formatCollapseNotice(report = {}) {
  const collapsed = Array.isArray(report?.collapsed) ? report.collapsed : [];
  if (collapsed.length === 0) return [];

  return collapsed.map((entry) => {
    const item = quoted(entry?.item);
    const count = Number(entry?.chunks) || 0;
    const capture = entry?.capture;
    const kept = Number.isInteger(capture)
      ? ` — raw chunks: read_chunkpaction({ capture: ${capture} })`
      : '';
    return `${COLLAPSE_NOTICE_PREFIX} Collapsed the solved section of ${item} (${plural(count, 'chunk')})${kept}.`;
  });
}

/**
 * Bind the announcement to a transcript logger. `notify(report)` prints the lines and
 * returns them, so the caller — and the tests — can see exactly what was shown.
 */
export function createCollapseNotifier({ log } = {}) {
  let announced = 0;

  return {
    notify(report) {
      const lines = formatCollapseNotice(report);
      if (lines.length === 0) return [];
      if (typeof log === 'function') {
        for (const line of lines) log(`\n${line}`);
      }
      announced += 1;
      return lines;
    },
    /** How many collapses have been announced so far. */
    get announced() {
      return announced;
    },
  };
}
