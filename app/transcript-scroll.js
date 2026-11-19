/**
 * The pure half of transcript scrolling: how far a gesture moves the view, and
 * whether an arriving message may move it at all.
 *
 * Split out of `app/transcript-view.js` (which was at its line budget) so the
 * numbers and the rule stay readable next to each other; the view imports and
 * re-exports every symbol here, so an importer cannot tell the difference.
 * Terminal-free, so each rule is unit tested without a widget.
 *
 * @see docs/interface/transcript-scroll, docs/interface/transcript-smooth-scroll
 */

/**
 * Scroll percentage that still counts as "at the bottom". blessed positions the
 * view to the very end (100) when the user presses End or the mouse reaches the
 * bottom bar, so a small tolerance absorbs a one-row rounding difference.
 */
export const FOLLOW_BOTTOM_PERCENT = 99.5;

/**
 * Rows one mouse-wheel notch moves the transcript.
 *
 * Deliberately smaller than a page: a wheel notch is a nudge, so a reader can
 * follow the text line by line instead of jumping a screenful at a time.
 */
export const WHEEL_STEP_ROWS = 3;

/**
 * Rows one page-up / page-down moves: a whole screenful minus one row, so the
 * row that was at the top of the screen is still the last row on the next page
 * and the reader never loses their place between two pages.
 *
 * Pure, so the step is unit tested without a terminal. A widget that has not
 * been laid out yet (no measured height) still steps one row rather than none.
 */
export function pageStepRows(visibleHeight = 0) {
  const visible = Number(visibleHeight) || 0;
  return visible > 1 ? Math.floor(visible) - 1 : 1;
}

/**
 * The follow/hold rule, as pure arithmetic: may an arriving message scroll the
 * transcript to the bottom?
 *
 * - **follow** when the view is parked at the bottom, so new output comes into
 *   sight as it arrives;
 * - **hold** when the user scrolled up to read history: the offset they chose
 *   must survive the append;
 * - **follow** when there is nothing to scroll yet (an unmeasured widget, or
 *   content that already fits), so a short transcript keeps following.
 *
 * @param {object} state
 * @param {number} state.percent        scroll position, 0..100
 * @param {number} state.scrollHeight   scrollable height in rows
 * @param {number} state.visibleHeight  rows of content on screen at once
 */
export function isFollowingScroll({ percent = 0, scrollHeight = 0, visibleHeight = 0 } = {}) {
  const height = Number(visibleHeight) || 0;
  const total = Number(scrollHeight) || 0;
  if (height <= 0 || total <= height) return true;
  return (Number(percent) || 0) >= FOLLOW_BOTTOM_PERCENT;
}
