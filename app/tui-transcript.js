import { createTranscriptView } from './transcript-view.js';

/**
 * The transcript *pane*: the model+view pair, the click that toggles a tool-result
 * block, and the four operations the rest of the screen asks of it (append prose,
 * append a collapsible block, scroll by rows, page).
 *
 * Extracted from `app/tui.js`, which was at its line budget: what stays there is
 * the *wiring* of the screen (which regions exist, which keys they answer), and
 * what lands here is the one region that owns a model of its own. The pane is the
 * seam the host talks to, so `app/tui.js` never reaches into the view.
 *
 * `stamp` is the per-entry timestamp hook (`app/transcript-stamp.js`): the TUI
 * passes `createStamper()` and the pane marks every entry it appends with the time
 * it appeared. The mark is display only — it never reaches a chunk or a session
 * file — and `setStamping(false)` turns it off while a stored conversation is
 * replayed, because those rows appeared in a past run.
 */
export function createTranscriptPane({ transcript, refresh = () => {}, stamp = null } = {}) {
  const view = createTranscriptView({ widget: transcript, refresh, stamp });

  // A click on the transcript toggles the tool-result block under the cursor
  // (expand, then collapse again on the next click).
  if (typeof transcript?.on === 'function') {
    transcript.on('click', (data) => view.clickAt(data));
  }

  return {
    view,
    /** Append plain text (prose, notices, tool-call headers, the user echo). */
    log: (...args) => view.log(...args),
    /**
     * Append one side of the dialogue with its background band: the user's echoed
     * prompt or the model's prose (`docs/interface/prose-bands`).
     */
    logProse: (role, text) => view.logProse(role, text),
    /**
     * Append a tool result as a collapsible block: one header line carrying the
     * "X char response" size, expanded by a click.
     */
    logBlock: (options) => view.logBlock(options),
    /** Scroll by rows (the wheel and the keyboard move the same distances). */
    scrollBy: (amount) => view.scrollRows(amount),
    /** Page towards the bottom (`direction < 0` pages up), one screenful minus one. */
    scrollPage: (direction) => view.scrollPage(direction),
    /** Drop every entry (resuming a session replaces the whole transcript). */
    clear: () => view.clear(),
    /** Turn the per-entry timestamps off while a stored conversation is replayed. */
    setStamping: (value) => view.setStamping(value),
    get model() {
      return view.model;
    },
    get content() {
      return view.content;
    },
    close: () => view.close(),
  };
}
