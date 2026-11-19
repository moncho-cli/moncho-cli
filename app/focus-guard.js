/**
 * Keeping the input box **armed**: the focus and the read cycle are one state, and
 * a stray event that takes either away leaves the user unable to type.
 *
 * The backlog item:
 *
 * > sometimes the input box for the message looses focus and i cant make it come
 * > back there, so i cant write anything. clicking should work, and periodically
 * > just put the focus back in there
 *
 * Two things go wrong in the widget layer, and neither of them is preventable from
 * the outside:
 *
 *  - **a click autofocuses the clicked region.** blessed focuses every `clickable`
 *    element that does not opt out (`lib/widgets/screen.js#Screen`, the
 *    `element click` handler). Focusing the transcript blurs the input box, and the
 *    textarea's own `blur` handler ends its read cycle
 *    (`lib/widgets/textarea.js#Textarea`): the keypress listener is removed and the
 *    box goes quietly deaf.
 *  - **the focus alone is not enough.** The box is deliberately created *without*
 *    blessed's `inputOnFocus` (`app/tui-layout.js`), so gaining the focus back never
 *    resumes the read — the box has to be **armed** again, which only
 *    `app/prompt-input.js#createPromptInput` knows how to do.
 *
 * So the box has one honest question — does it own the focus *and* is it reading? —
 * and the answer is to arm it again. `needsFocus()` is the question;
 * `createFocusGuard()` is the watchdog that asks it on an interval, which is the
 * "periodically just put the focus back in there" clause, plus on a click on the box
 * itself, which is the "clicking should work" clause.
 *
 * Pure in the model sense: the widget, the arming hook, the read probe, the "should
 * the box be armed at all" rule and even the clock are injected, so every rule below
 * is unit testable without a terminal. The timer is `unref`'d, so a watchdog can
 * never hold the process open.
 */

/**
 * How often the guard re-checks the box. Often enough that a lost focus is repaired
 * before the user notices, cheap enough (one boolean comparison) to run for a whole
 * session.
 */
export const FOCUS_CHECK_INTERVAL_MS = 1000;

/**
 * Does the box need to be armed again?
 *
 * `true` when either half of the armed state is missing: the focus (`screen.focused`
 * is not the box) or the read cycle (the textarea's `_reading` flag is not set). Both
 * are required — a focused box that is not reading swallows every keystroke, and a
 * reading box that lost the focus never receives one.
 *
 * Pure: the caller reads the two facts off the widget, this decides.
 */
export function needsFocus({ focused = false, reading = false } = {}) {
  return focused !== true || reading !== true;
}

/**
 * @param {object} options
 * @param {object} [options.inputBox]  the blessed textbox to keep armed
 * @param {Function} [options.arm]     how the box is armed (app/prompt-input.js#arm)
 * @param {Function} [options.reading] whether the box is in its read cycle
 * @param {Function} [options.hold]    whether the box *should* be armed right now
 * @param {number} [options.intervalMs] how often the periodic check runs
 * @param {{set: Function, clear: Function}} [options.timer] the timer, injectable
 */
export function createFocusGuard({
  inputBox = null,
  arm = null,
  reading = null,
  hold = null,
  intervalMs = FOCUS_CHECK_INTERVAL_MS,
  timer = { set: setInterval, clear: clearInterval },
} = {}) {
  let handle = null;
  let closed = false;
  let checks = 0;
  let repairs = 0;

  /** Whether the box owns the screen's focus right now. */
  const isFocused = () => {
    const screen = inputBox?.screen;
    return Boolean(screen) && screen.focused === inputBox;
  };

  /**
   * Whether the box is inside its read cycle. Read off the widget's own flag by
   * default — that flag *is* the read cycle — and overridable, so the caller can
   * expose the same fact under its own name (`app/prompt-input.js#isReading`).
   */
  const isReading = () => {
    if (typeof reading === 'function') return reading() === true;
    return inputBox?._reading === true;
  };

  /**
   * Whether the box is supposed to be armed at all. A guard that armed the box
   * unconditionally would arm it while nobody is waiting for an answer, which is
   * exactly the state `question()` and the in-flight capture exist to avoid.
   */
  const isHeld = () => typeof hold === 'function' && hold() === true;

  /**
   * Whether something else owns the keyboard right now. A modal locks the screen's
   * key dispatch while it is open (`app/tui-modal.js`), and its own hand-back focuses
   * the box: arming underneath it would fight the modal, so the guard stands down.
   */
  const isLocked = () => inputBox?.screen?.lockKeys === true;

  /** Arm the box: the caller's hook when it has one, the two blessed calls otherwise. */
  const armBox = () => {
    if (typeof arm === 'function') return arm() !== false;
    if (!inputBox) return false;
    if (typeof inputBox.focus === 'function') inputBox.focus();
    if (typeof inputBox.readInput === 'function') inputBox.readInput();
    return true;
  };

  /**
   * One check, and the repair when it is needed. Returns `true` only when the box was
   * actually re-armed, so a caller (and the tests) can tell a repair from a no-op.
   *
   * Nothing here runs while the box is closed, not supposed to be armed, or while a
   * modal holds the keys — the three ways a "helpful" watchdog would be harmful.
   */
  const ensure = () => {
    if (closed || !inputBox) return false;
    if (!isHeld() || isLocked()) return false;
    checks += 1;
    if (!needsFocus({ focused: isFocused(), reading: isReading() })) return false;
    if (!armBox()) return false;
    repairs += 1;
    return true;
  };

  /** Start the periodic check; idempotent. */
  const start = () => {
    if (closed || handle !== null) return false;
    handle = timer.set(() => { ensure(); }, intervalMs);
    if (typeof handle?.unref === 'function') handle.unref();
    return true;
  };

  /** Stop the periodic check without closing the guard. */
  const stop = () => {
    if (handle === null) return false;
    timer.clear(handle);
    handle = null;
    return true;
  };

  return {
    ensure,
    start,
    stop,
    /** Release the timer for good (screen teardown): a closed guard never arms again. */
    close() {
      if (closed) return false;
      closed = true;
      stop();
      return true;
    },
    /** True while the periodic check is armed. */
    isRunning: () => handle !== null,
    /** True while the box is supposed to be armed (the caller's rule). */
    isHeld,
    /** How many checks got past the stand-down rules and looked at the box. */
    get checks() {
      return checks;
    },
    /** How many times the box was actually re-armed. */
    get repairs() {
      return repairs;
    },
    get isClosed() {
      return closed;
    },
  };
}

/**
 * Bind the guard to a real input box: create it, handle a click on the box itself
 * (the "clicking should work" clause) and let the caller start the periodic check
 * (the "periodically just put the focus back in there" clause).
 *
 * The click is handled here rather than by blessed's own `autoFocus`, which focuses
 * through `screen.focused = el` and therefore emits a `blur` on the box -- ending the
 * read it is holding. `ensure()` only focuses when the box does not already own the
 * focus, so clicking an armed box changes nothing and a lost one is repaired.
 *
 * The returned guard closes the click listener too, so tearing the screen down leaves
 * nothing behind.
 */
export function bindFocusGuard({
  inputBox = null,
  promptInput = null,
  hold = null,
  intervalMs = FOCUS_CHECK_INTERVAL_MS,
  timer = { set: setInterval, clear: clearInterval },
} = {}) {
  const guard = createFocusGuard({
    inputBox,
    arm: promptInput ? () => promptInput.arm() : null,
    reading: promptInput ? () => promptInput.isReading : null,
    hold,
    intervalMs,
    timer,
  });

  const onClick = () => guard.ensure();
  if (inputBox && typeof inputBox.on === 'function') inputBox.on('click', onClick);

  const closeGuard = guard.close;
  return Object.defineProperties(guard, {
    /** Detach the click listener and release the periodic check. */
    close: {
      value: () => {
        if (inputBox && typeof inputBox.removeListener === 'function') {
          inputBox.removeListener('click', onClick);
        }
        return closeGuard();
      },
      enumerable: true,
    },
  });
}
