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
 * right-aligned), the working-time row above it (right-aligned against the very
 * same column), the queue previews (fitted to the bar's columns, which would
 * otherwise keep the width of the old terminal), and the three floating bars as a
 * group (the brand line, which may start or stop fitting whole and move the top of
 * the conversation, and the notices and the copy toast that hang below it).
 *
 * @param {object} regions the row-based regions and the repaint of the screen
 * @param {Function} [regions.refresh] paints the screen; required for the re-fit to show
 * @returns {() => void} the listener, so a caller can detach it
 */
export function createResizeRepaint({
  screen,
  transcript,
  statusRow,
  workRow = null,
  queue,
  overlays = null,
  refresh = null,
} = {}) {
  const repaint = () => {
    // Regions are laid out relatively, so the newest line has to be put back in
    // view: the transcript keeps its reader offset, and a resize is not a scroll.
    transcript?.setScrollPerc?.(100);
    statusRow?.render?.();
    // The counter sits directly above the meter and is pinned to the same right
    // edge, so it is re-fitted with it rather than a cell behind it.
    workRow?.render?.();
    queue?.paint?.();
    // The three floating bars are a group (app/tui-overlays.js): the brand line owns the
    // first row and the notices and the copy toast both hang below it, so re-fitting one
    // of them without the others would stack them wrong. `overlays.paint()` does all
    // three in that order, which also re-reads the brand row after a resize.
    overlays?.paint?.();
    // blessed paints the screen *before* it emits 'resize' (`screen.js`: alloc(),
    // render(), then the event), so without this second paint the re-fit above would
    // only reach the next frame — and the frame in between is the all-black flash the
    // backlog reports. Rendering here closes that gap, and a closed screen is guarded
    // by the refresh latch (`app/tui-screen.js`).
    refresh?.();
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
