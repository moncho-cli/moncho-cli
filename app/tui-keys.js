import { isInterruptKey, isTabKey, isShiftTabKey } from '../utils/keys.js';

/**
 * The TUI's key bindings, kept apart from the screen wiring.
 *
 * Two families of keys arrive here and they are handled at different levels:
 *
 * - **Escape / Ctrl+C and Tab** must be taken *before* blessed dispatches them.
 *   While the input box is reading, screen-level listeners are skipped and
 *   textarea turns Escape into its own `cancel` event: the box blurs and the
 *   armed `question()` promise is never resolved. Tab is worse: textarea's
 *   listener appends every `ch` that is not a control byte, and `\x09` is *not*
 *   excluded, so a plain `screen.on('keypress')` binding would both fire *and*
 *   type a tab into the prompt. Handling the key on the program and locking key
 *   dispatch for that single event keeps the box reading, the tab out of it and
 *   the host in control.
 * - **Scrolling keys** are bound on the *screen*, not on the program, because the
 *   tests drive them with `screen.emit('keypress', …)`; `screen.key()` would bind
 *   on `screen.program` instead and the synthetic event would miss.
 *
 * `dispose()` detaches the program listener, so `close()` leaves no key handler
 * behind.
 */
export function bindKeys({
  screen, onInterrupt, onCycleMode, scrollPage, transcript, refresh,
} = {}) {
  if (!screen) return { dispose() {} };

  /** Lock key dispatch for this one event, so blessed skips the focused widget. */
  const lockOnce = () => {
    screen.lockKeys = true;
    queueMicrotask(() => {
      screen.lockKeys = false;
    });
  };

  /**
   * The pre-dispatch gate: interrupts and Tab are answered here, before blessed
   * can hand the key to the focused widget. Anything else falls through untouched.
   */
  const onProgramKeypress = (ch, key) => {
    if (isInterruptKey(ch, key)) {
      lockOnce();
      if (typeof onInterrupt === 'function') onInterrupt();
      return true;
    }
    if (isTabKey(ch, key)) {
      // Shift+Tab walks the ring the other way. The binding only decides the
      // direction; what a move means stays in app/session-mode.js.
      const direction = isShiftTabKey(ch, key) ? -1 : 1;
      lockOnce();
      if (typeof onCycleMode === 'function') onCycleMode({ direction });
      return true;
    }
    return false;
  };

  screen.program.prependListener('keypress', onProgramKeypress);

  const onKeypress = (ch, key) => {
    if (!key) return;
    if (isInterruptKey(ch, key)) {
      if (typeof onInterrupt === 'function') onInterrupt();
      return;
    }

    const name = key.full || key.name;
    if (name === 'pageup' || name === 'S-up') {
      if (typeof scrollPage === 'function') scrollPage(-1);
    } else if (name === 'pagedown' || name === 'S-down') {
      if (typeof scrollPage === 'function') scrollPage(1);
    } else if (name === 'home') {
      transcript?.setScrollPerc(0);
      if (typeof refresh === 'function') refresh();
    } else if (name === 'end') {
      transcript?.setScrollPerc(100);
      if (typeof refresh === 'function') refresh();
    }
  };
  screen.on('keypress', onKeypress);

  return {
    dispose() {
      screen.program.removeListener('keypress', onProgramKeypress);
      screen.removeListener('keypress', onKeypress);
    },
  };
}
