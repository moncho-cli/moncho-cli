/**
 * The TUI's lifecycle: what happens when the terminal is resized and when the
 * screen is torn down.
 *
 * Both are one-way edges of the widget graph — a resize has to re-fit every row
 * that was measured at the old width, and a close has to release every region the
 * layout built, in the reverse order it built them. Keeping them here leaves
 * `app/tui.js` the *wiring* of the screen (which regions exist and how they are
 * connected) instead of the place where the teardown order is remembered.
 *
 * The callbacks are the small surface `createTui()` already holds, so this module
 * never imports blessed: it is a pure sequence of calls, and every step is a no-op
 * when the region it names was never built.
 */

/**
 * Re-fit the row-based regions when the terminal's size changes.
 *
 * blessed relayouts the relatively positioned regions itself, so what is left is
 * the work that depends on the *width*: the status row (whose meter is
 * right-aligned), the queue previews (fitted to the bar's columns, which would
 * otherwise keep the width of the old terminal), the brand line (which may start or
 * stop fitting whole, moving the top of the conversation) and the notices that
 * follow it.
 *
 * @param {object} regions the row-based regions and the repaint of the screen
 * @returns {() => void} the listener, so a caller can detach it
 */
export function createResizeRepaint({
  screen,
  transcript,
  statusRow,
  queue,
  brandBar,
  noticeBar,
} = {}) {
  const repaint = () => {
    // Regions are laid out relatively, so the newest line has to be put back in
    // view: the transcript keeps its reader offset, and a resize is not a scroll.
    transcript?.setScrollPerc?.(100);
    statusRow?.render?.();
    queue?.paint?.();
    brandBar?.paint?.();
    noticeBar?.paint?.();
  };
  screen?.on?.('resize', repaint);
  return repaint;
}

/**
 * Tear the screen down exactly once.
 *
 * The order matters and is the reverse of construction: the input box stops
 * accepting keystrokes first (abandoning a question nobody will answer), then the
 * regions that own timers or widgets are closed, then the widgets' own listeners are
 * removed, and finally the screen itself is destroyed. Calling `close()` twice must
 * be harmless — the host loop closes on exit and the process may exit as well.
 *
 * @param {object[]} steps the teardown of each region, run in the order given
 * @param {{ destroy?: () => void }} [screen] the blessed screen, destroyed last
 * @param {{ isClosed?: () => boolean, markClosed?: () => void }} [state] the latch
 * @returns {() => void} the idempotent close
 */
export function createTeardown({ steps = [], screen = null, state = {} } = {}) {
  const isClosed = typeof state.isClosed === 'function' ? state.isClosed : () => false;
  const markClosed = typeof state.markClosed === 'function' ? state.markClosed : () => {};

  return function close() {
    if (isClosed()) return;
    markClosed();
    for (const step of steps) {
      if (typeof step === 'function') step();
    }
    screen?.destroy?.();
  };
}
