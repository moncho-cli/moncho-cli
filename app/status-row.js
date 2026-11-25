import { composeStatusRow, sanitize } from './tui-render.js';

/** Braille frames painted in the status bar while a request is in flight. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Spinner refresh interval in milliseconds. */
export const SPINNER_INTERVAL_MS = 90;

/**
 * Content of the status bar, which carries two independent pieces of information
 * on a single row:
 *
 *   left  — the logical status text, or the animated spinner frame while a
 *           request is in flight;
 *   right — the context-window meter, pinned to the right edge and **always
 *           visible**, including while the spinner owns the left slot.
 *
 * Pure bookkeeping: the caller injects `paint(line)` and the usable `width()`, so
 * the whole row can be tested without a terminal (app/tui.js supplies the blessed
 * widgets).
 */
export function createStatusRow({
  paint = null,
  width = () => 0,
  initialStatus = 'Ready',
  intervalMs = SPINNER_INTERVAL_MS,
} = {}) {
  let statusText = initialStatus == null ? '' : String(initialStatus);
  let meterText = '';
  let spinnerTimer = null;
  let spinnerFrame = 0;
  let spinnerLabel = 'Thinking';
  let disposed = false;

  /** Left slot: the spinner while spinning, the logical status otherwise. */
  const left = () => {
    if (spinnerTimer) {
      const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
      return `${spinnerLabel} ${frame}`;
    }
    return statusText;
  };

  /** Repaint the composed row; the meter is re-pinned on every frame. */
  const render = () => {
    if (disposed) return false;
    const line = composeStatusRow(sanitize(left()), sanitize(meterText), width());
    if (typeof paint === 'function') paint(line);
    return true;
  };

  const stopTimer = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    spinnerFrame = 0;
  };

    return {
    render,
    /**
     * The left slot as it is painted right now — the spinner frame while a
     * request is in flight, the logical status otherwise.
     *
     * Exposed because something other than the painter has to know what the slot
     * says: the `Thinking` label is a click target while it is up
     * (`app/thinking-view.js`), and the hit zone is measured against these exact
     * cells rather than against a second guess at them.
     */
    leftText: () => sanitize(left()),
    /** Set the logical status text (the left slot when idle). */
    setStatus(text) {
      statusText = text == null ? '' : String(text);
      return render();
    },
    /** Set the context-window meter, right-aligned and always visible. */
    setMeter(text) {
      meterText = text == null ? '' : String(text);
      return render();
    },
    /** Start the animated frame; the meter keeps painting alongside it. */
    startSpinner(label = 'Thinking') {
      spinnerLabel = typeof label === 'string' && label ? label : 'Thinking';
      if (spinnerTimer || disposed) return false;
      spinnerFrame = 0;
      spinnerTimer = setInterval(() => {
        spinnerFrame += 1;
        render();
      }, intervalMs);
      if (typeof spinnerTimer.unref === 'function') spinnerTimer.unref();
      // Arm the timer *before* painting: the left slot is derived from the
      // in-flight state, so painting first would show the stale status text.
      render();
      return true;
    },
    /**
     * Stop the timer and repaint: the logical status text comes back by itself,
     * because the left slot is derived, and no spinner frame is left behind.
     */
    stopSpinner() {
      stopTimer();
      return render();
    },
    /** Release the timer for good (screen teardown). */
    dispose() {
      stopTimer();
      disposed = true;
    },
    isSpinning: () => spinnerTimer !== null,
    get statusText() {
      return statusText;
    },
    get meterText() {
      return meterText;
    },
    get spinnerLabel() {
      return spinnerLabel;
    },
  };
}
