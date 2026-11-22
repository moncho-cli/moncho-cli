import { isInterruptKey, isTabKey, isShiftTabKey } from '../utils/keys.js';
import {
  claimKeyboard, releaseKeyboardLater, keyboardHeldBy, KEYBOARD_OWNER_MODAL,
  KEYBOARD_OWNER_EVENT,
} from './keyboard-ownership.js';

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
  screen, onInterrupt, onCycleMode, scrollPage, transcript, refresh, onComplete = null,
} = {}) {
  if (!screen) return { dispose() {} };

  /**
   * Lock key dispatch for this one event, so blessed skips the focused widget.
   *
   * The lock is a **lease** (`app/keyboard-ownership.js`), not a boolean: it is taken
   * for the one event and released at the end of it, and it can never unlock a modal
   * that is still open — a plain `screen.lockKeys = false` would clear the lock of a
   * modal that had nothing to do with this key.
   */
  const lockOnce = () => {
    const lease = claimKeyboard({ screen, label: KEYBOARD_OWNER_EVENT });
    releaseKeyboardLater(lease);
  };

  /**
   * The pre-dispatch gate: interrupts and Tab are answered here, before blessed
   * can hand the key to the focused widget. Anything else falls through untouched.
   *
   * Tab is the popup's while the popup is open: `onComplete` returns true when it took
   * the key (and completed the command name into the box), in which case the mode ring
   * does not move. That ordering is deliberate — a reader typing `/se` and pressing Tab
   * means "finish this command", and only an open menu can tell that apart from a
   * request to change mode.
   */
  const onProgramKeypress = (ch, key) => {
    // A modal owns the keyboard while it is open (`app/keyboard-ownership.js`): the
    // key that closes the modal is still travelling through the program's listeners,
    // so the host must see the modal as the owner of *that* key. Escape then cancels
    // the modal and leaves the running turn alone, and Tab moves the modal's focus
    // instead of cycling the session mode. Before the lease existed, both happened at
    // once: Escape aborted the very turn the modal was a part of.
    if (keyboardHeldBy(KEYBOARD_OWNER_MODAL)) return false;
    if (isInterruptKey(ch, key)) {
      lockOnce();
      if (typeof onInterrupt === 'function') onInterrupt();
      return true;
    }
    if (isTabKey(ch, key)) {
      if (typeof onComplete === 'function' && onComplete()) {
        lockOnce();
        return true;
      }
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
