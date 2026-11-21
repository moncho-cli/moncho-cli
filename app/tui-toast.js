import blessed from 'neo-blessed';
import { createToast, TOAST_TTL_MS } from './toast.js';

/**
 * Bind the toast model (`app/toast.js`) to a small bordered box in the **top-right
 * corner**: the "Copied text to clipboard" confirmation the reader asked for.
 *
 * Four decisions, each for a reason the notice overlay does not share:
 *
 *  - **top-right, and only as wide as its sentence.** A confirmation is glanced at, not
 *    read across the screen, and the corner is where the eye already is when the pointer
 *    is in the conversation. The width is therefore measured from the text rather than
 *    stretched between `left: 0` and `right: 0`.
 *  - **hidden while there is nothing to say**, so a quiet session shows no chrome and the
 *    box costs no rows.
 *  - **it hides itself on a timer armed for the expiry**, not on an interval, so exactly
 *    one wake-up happens per toast. The timer is `unref`'d, so a pending toast never keeps
 *    the process alive.
 *  - **`top` is re-read on every paint**, because the brand line can hide itself on a
 *    narrow window and that moves "the top of the screen" down a row.
 *
 * Pure in the model sense: with no screen the whole thing still works (it just paints
 * nothing), which is how the line CLI and the unit tests drive it.
 */
export function createToastBar({
  screen = null,
  anchor = null,
  toast = null,
  ttlMs = TOAST_TTL_MS,
  now = () => Date.now(),
  refresh = () => {},
} = {}) {
  const model = toast || createToast({ ttlMs, now });
  const clock = typeof toast?.now === 'function' ? toast.now : now;
  let closed = false;
  let timer = null;
  let painted = '';

  /** The row the box hangs from: one under the brand mark while it is shown. */
  const anchorRow = () => {
    const value = typeof anchor === 'function' ? anchor() : 1;
    return Math.max(0, Math.trunc(Number(value)) || 0);
  };

  /** The box is as wide as its sentence, plus its padding and border, capped to the screen. */
  const boxWidth = (text) => {
    const columns = Number(screen?.width) || 0;
    const wanted = [...String(text ?? '')].length + 6;
    return columns > 0 ? Math.min(columns, Math.max(6, wanted)) : Math.max(6, wanted);
  };

  const widget = screen
    ? blessed.box({
      parent: screen,
      top: anchorRow(),
      // Right-aligned by pinning `right` and letting the width do the rest, so a resize
      // keeps the box in the corner instead of moving it off the edge.
      right: 0,
      width: 6,
      height: 3,
      border: { type: 'line' },
      tags: true,
      hidden: true,
      padding: { left: 1, right: 1 },
      style: { border: { fg: 'green' } },
    })
    : null;

  const clearTimer = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** One wake-up, at the moment the live toast expires. */
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
   * Repaint from the model: the message becomes the box's content, its width follows the
   * sentence, the box is hidden when the toast is gone, and the expiry is re-armed.
   */
  const paint = () => {
    if (closed) return '';
    painted = model.current;
    if (widget) {
      widget.top = anchorRow();
      widget.width = boxWidth(painted);
      widget.setContent(painted);
      widget.hidden = painted === '';
    }
    armTimer();
    refresh();
    return painted;
  };

  const unsubscribe = model.subscribe(() => {
    paint();
  });

  return {
    toast: model,
    widget,
    paint,
    /** Show the confirmation; returns the text shown (null for blank text). */
    show: (text) => model.show(text),
    hide: () => model.hide(),
    /** The message on screen right now, or '' when idle. */
    get current() {
      return model.current;
    },
    get visible() {
      return model.visible;
    },
    /** When it will hide itself (ms from now), or null when idle. */
    timeToHide() {
      const expiry = model.nextExpiry();
      return expiry === null ? null : Math.max(0, expiry - clock());
    },
    close() {
      if (closed) return;
      closed = true;
      painted = '';
      clearTimer();
      unsubscribe();
      model.close();
      if (widget && typeof widget.destroy === 'function') widget.destroy();
    },
  };
}