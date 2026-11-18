import { isInterruptKey } from '../utils/keys.js';

/**
 * The TUI's key bindings, kept apart from the screen wiring.
 *
 * Two families of keys arrive here and they are handled at different levels:
 *
 * - **Escape / Ctrl+C** must be taken *before* blessed dispatches them. While the
 *   input box is reading, screen-level listeners are skipped and textarea turns
 *   Escape into its own `cancel` event: the box blurs and the armed `question()`
 *   promise is never resolved. Handling the key on the program and locking key
 *   dispatch for that single event keeps the box reading while the host reacts.
 * - **Scrolling keys** are bound on the *screen*, not on the program, because the
 *   tests drive them with `screen.emit('keypress', …)`; `screen.key()` would bind
 *   on `screen.program` instead and the synthetic event would miss.
 *
 * `dispose()` detaches the program listener, so `close()` leaves no key handler
 * behind.
 */
export function bindKeys({ screen, onInterrupt, scrollPage, transcript, refresh } = {}) {
  if (!screen) return { dispose() {} };

  const interrupt = (ch, key) => {
    if (!isInterruptKey(ch, key)) return false;
    screen.lockKeys = true;
    queueMicrotask(() => {
      screen.lockKeys = false;
    });
    if (typeof onInterrupt === 'function') onInterrupt();
    return true;
  };

  screen.program.prependListener('keypress', interrupt);

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
      screen.program.removeListener('keypress', interrupt);
      screen.removeListener('keypress', onKeypress);
    },
  };
}
