import blessed from 'neo-blessed';
import { STAMP_COLOR } from './theme-palette.js';
import { fgTag } from './paint-tags.js';
import { displayWidth } from './cell-width.js';
import { contentOrigin, scrollBase, visibleHeight } from './transcript-geometry.js';
import { isStickyDue, lastUserEntry, stickyLine } from './transcript-sticky.js';

/**
 * Bind the sticky last-user-message model (`app/transcript-sticky.js`) to a floating
 * blessed row at the top of the conversation.
 *
 * The row is **floating**, like the notice overlay (`app/notice-bar.js`): it sits over
 * the first content row of the transcript instead of taking a row from it, so the layout
 * below never moves and a scroll is never a reflow. It is one row, pinned under the
 * transcript's own border, and it is hidden whenever the pin is not due — the empty
 * conversation, the reader parked at the bottom, and the case where the real prompt row is
 * still on screen.
 *
 * The three decisions that keep it honest:
 *
 *  - **a view, not a copy.** Its text comes from the model on every paint (`records`, the
 *    transcript's `lineRecords()`), so a prompt that was cut by a narrow window is re-cut
 *    when the window widens, and the stamp is the one the entry was appended with rather
 *    than a fresh clock reading. The two inputs are deliberately separate: `records` is the
 *    *conversation* (the view's model) and `transcript` is the *widget*, which is the only
 *    thing that knows where the viewport is.
 *  - **it repaints from the same seam as everything else.** The transcript asks it to
 *    re-read after every paint and after every scroll (`app/transcript-viewport.js` calls
 *    back through `repaint`), so it can never lag the content by a frame.
 *  - **it never takes a keystroke or the focus.** It is not `clickable` and does not read
 *    input: the input box is the single arming point of the screen
 *    (`docs/interface/input-focus`), and a floating row that could be focused would be
 *    the next "the box lost focus" bug.
 */
export function createStickyBar({
  screen = null,
  transcript = null,
  records = null,
  refresh = () => {},
} = {}) {
  let closed = false;

  const widget = screen
    ? blessed.box({
      parent: screen,
      left: 0,
      right: 0,
      height: 1,
      tags: true,
      hidden: true,
      // The same interior inset as the transcript it floats over (border + padding), so a
      // pinned row starts on the same column as the text it belongs to.
      padding: { left: 2, right: 2 },
    })
    : null;

  /** The width the row really has, in cells: the screen less the bar's own insets. */
  const rowWidth = () => {
    const width = Number(screen?.width) || 0;
    if (width > 4) return width - 4;
    // No screen (a line CLI, a unit test): fit to the transcript's own wrap width, which
    // is the width the rows being explained were cut to.
    const fallback = Number(transcript?.width) || 0;
    return Math.max(1, fallback > 4 ? fallback - 4 : 80);
  };

  /**
   * The screen row the pin belongs on: the transcript's first *content* row, so it sits
   * inside the border rather than over it. With no layout yet it falls back to the
   * transcript's painted origin, and with neither to row 1.
   */
  const rowTop = () => {
    const origin = contentOrigin(transcript);
    if (origin) return origin.contentY;
    const top = Number(transcript?.lpos?.yi);
    return Number.isFinite(top) ? top + 1 : 1;
  };

  /**
   * Re-read the model and repaint. Returns the line painted (`''` when the row is hidden),
   * so the wiring and the tests can tell a hide from a paint without reaching the widget.
   */
  const paint = () => {
    if (closed) return '';
    const list = typeof records === 'function' ? (records() ?? []) : [];
    const entry = lastUserEntry(list);
    const due = entry
      ? isStickyDue({
        index: entry.index,
        scrollBase: scrollBase(transcript),
        visibleHeight: visibleHeight(transcript),
      })
      : false;

    if (!due) {
      if (widget) {
        widget.hidden = true;
        widget.setContent('');
      }
      refresh();
      return '';
    }

    const line = stickyLine({ text: entry.text, stamp: entry.stamp, width: rowWidth() });
    if (!line) {
      if (widget) {
        widget.hidden = true;
        widget.setContent('');
      }
      refresh();
      return '';
    }

    if (widget) {
      // The row is chrome, so it is painted in the stamp colour rather than in the user's
      // band: a pinned row that looked like a message would read as a second message.
      widget.top = rowTop();
      widget.setContent(fgTag(STAMP_COLOR, line));
      widget.hidden = false;
    }
    refresh();
    return line;
  };

  return {
    widget,
    paint,
    /** The line on screen right now (`''` while hidden). */
    get line() {
      return closed ? '' : (widget && widget.hidden === false ? String(widget.content ?? '') : '');
    },
    get visible() {
      return Boolean(widget) && widget.hidden === false;
    },
    /** The width the pin is fitted to, in cells (read live: a resize changes it). */
    get width() {
      return rowWidth();
    },
    close() {
      if (closed) return;
      closed = true;
      if (widget && typeof widget.destroy === 'function') widget.destroy();
    },
  };
}