import blessed from 'neo-blessed';
import {
  createNoticeOverlay,
  NOTICE_MAX_ROWS,
  NOTICE_TTL_MS,
} from './notice-overlay.js';

/**
 * Bind the transient-notice model to a floating blessed box near the top of the
 * screen (task-backlog: "this info should also be displayed in some kind of overlay
 * near the top of the screen and auto hide after some minutes").
 *
 * The model (`app/notice-overlay.js`) owns the kinds, the expiry and the rows; this
 * module is only the screen binding:
 *
 *  - it creates a **floating** box — the width of the screen, no border — so it sits
 *    over the top of the transcript instead of taking a row from it and the layout
 *    below never moves. Its `anchor` is where "the top" is right now: one row under
 *    the brand line (`app/brand-bar.js`), so a notice never covers the mark;
 *  - it is **hidden while there is nothing live**, so a quiet session shows no
 *    chrome at all;
 *  - it **hides itself** on a timer: the timer is armed for the earliest expiry, not
 *    for a fixed interval, so a notice goes away when it is due and no repaint loop
 *    runs in between. The timer is unref'd, so a pending notice never keeps the
 *    process alive.
 *
 * Pure in the model sense: with no widget the whole thing still works (it just
 * paints nothing), which is how the line CLI and the unit tests drive it.
 */
export function createNoticeBar({
  screen = null,
  overlay = null,
  anchor = null,
  maxRows = NOTICE_MAX_ROWS,
  ttlMs = NOTICE_TTL_MS,
  now = () => Date.now(),
  refresh = () => {},
} = {}) {
  const model = overlay || createNoticeOverlay({ maxRows, ttlMs, now });
  // The overlay's clock drives the timer too, so the delay is measured against the
  // very same "now" the expiry was computed from (and is testable with a fake one).
  const clock = typeof overlay?.now === 'function' ? overlay.now : now;
  let closed = false;
  let timer = null;
  let painted = 0;

  /**
   * The row the overlay hangs from: one under the brand mark while it is shown, the
   * top edge otherwise. `anchor` is a function because the top of the screen moves
   * when the brand line hides or returns.
   */
  const anchorRow = () => {
    const value = typeof anchor === 'function' ? anchor() : 1;
    return Math.max(0, Math.trunc(Number(value)) || 0);
  };

  const widget = screen
    ? blessed.box({
      parent: screen,
      top: anchorRow(),
      left: 0,
      right: 0,
      height: 0,
      tags: true,
      hidden: true,
      padding: { left: 1, right: 1 },
    })
    : null;

  /** Cancel the pending expiry, if any. */
  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /**
   * Arm one timer for the earliest expiry. `unref` keeps a pending notice from
   * holding the event loop open, so the agent still exits when the user leaves.
   */
  const armTimer = () => {
    clearTimer();
    if (closed) return null;
    const expiry = model.nextExpiry();
    if (expiry === null) return null;
    const delay = Math.max(0, expiry - clock());
    timer = setTimeout(() => {
      timer = null;
      paint();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    return delay;
  };

  /**
   * Repaint from the model: the rows become the widget content, the box is sized to
   * them and hidden when there are none, and the expiry timer is re-armed.
   */
  const paint = () => {
    if (closed) return [];
    // Re-read the anchor on every paint: the brand line above may have hidden itself
    // (a narrow window), which moves "the top of the transcript" back to row 0.
    if (widget) widget.top = anchorRow();
    const rows = model.rows({ maxRows });
    painted = rows.length;

    if (widget) {
      widget.setContent(rows.join('\n'));
      widget.height = rows.length;
      widget.hidden = rows.length === 0;
    }
    armTimer();
    refresh();
    return rows;
  };

  // Every change (add, dismiss, clear) repaints: the widget is a view of the model.
  const unsubscribe = model.subscribe(() => {
    paint();
  });

  return {
    overlay: model,
    widget,
    paint,
    /** Show a transient notice; returns its handle (null for blank text). */
    notify: (kind, text, options) => model.add(kind, text, options),
    /** Take one notice down by handle (a failure that recovered). */
    dismiss: (id) => model.dismiss(id),
    clear: () => model.clear(),
    /** Rows painted right now; 0 while nothing is live. */
    get rows() {
      return painted;
    },
    get visible() {
      return painted > 0;
    },
    get notices() {
      return model.notices;
    },
    /** When the overlay will hide itself (ms from now), or null when idle. */
    timeToHide() {
      const expiry = model.nextExpiry();
      return expiry === null ? null : Math.max(0, expiry - clock());
    },
    close() {
      if (closed) return;
      closed = true;
      // A closed bar paints nothing, so it must not still read as visible.
      painted = 0;
      clearTimer();
      unsubscribe();
      model.close();
      if (widget && typeof widget.destroy === 'function') widget.destroy();
    },
  };
}
