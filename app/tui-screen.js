import blessed from 'neo-blessed';

/**
 * The blessed screen itself, and the repaint latch that goes with it.
 *
 * Two decisions live here and nowhere else, both of them about how blessed is set up
 * rather than what the TUI draws:
 *
 *  - **`forceUnicode`.** `fullUnicode` alone is not enough: neo-blessed derives the flag
 *    from the **terminfo** entry it managed to parse (`screen.js#Screen`:
 *    `this.fullUnicode = this.options.fullUnicode && this._unicode`), so on a box whose
 *    entry it cannot read (no terminfo, an unknown `$TERM`) `_unicode` stays false and the
 *    widget replaces every double-width glyph with `??` (`element.js#Element.render`:
 *    `content.replace(unicode.chars.all, '??')`). That is what turned every emoji in the
 *    conversation into question marks. `forceUnicode` makes the screen trust the terminal
 *    rather than the terminfo entry.
 *  - **the repaint latch.** `stdout` is not a TTY when `./start.sh start` runs detached
 *    (no pty) and there is no screen to build at all; once there is one, every part of the
 *    wiring repaints through the same `refresh`, and a closed screen is never rendered
 *    again — a render after `destroy()` is what turns a clean exit into a stack trace.
 *
 * Extracted from `app/tui.js` to keep the wiring module inside the project's line budget;
 * it is the *setup* of the screen, not a region on it.
 */
export function createScreen({ input, output } = {}) {
  if (!output?.isTTY) return null;

  const screen = blessed.screen({
    input,
    output,
    smartCSR: true,
    fullUnicode: true,
    forceUnicode: true,
    title: 'Moncho',
    warnings: false,
    autoPadding: true,
  });

  let closed = false;

  return {
    screen,
    /** Repaint, unless the screen has already been torn down. */
    refresh() {
      if (!closed) screen.render();
    },
    /** True once `close()` has run, so no region repaints a destroyed screen. */
    isClosed() {
      return closed;
    },
    markClosed() {
      closed = true;
    },
  };
}