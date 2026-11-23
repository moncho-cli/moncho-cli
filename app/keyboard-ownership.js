/**
 * Who owns the keyboard, and the one blessed lock that follows from it.
 *
 * A modal takes the keyboard while it is open: the keys it answers must not reach
 * the input box, the transcript, or the host's own bindings. Blessed offers a single
 * switch for that — `screen.lockKeys` — and it gates blessed's *own* dispatch
 * (`lib/widgets/screen.js`: the screen's keypress handler returns while it is true).
 * That same flag also returns early from blessed's **mouse** dispatcher, which is why
 * `unlockMouse()` below exists: a modal that keeps the keyboard and still wants the
 * pointer (a viewer the user selects text in) asks for the mouse back explicitly.
 * The lock does **not** gate the other program-level listeners: the host's
 * (`app/tui-keys.js`), which answers Escape and Tab for the whole program.
 *
 * So a lock alone is not ownership. Two things are needed, and this module is both:
 *
 *  - **the claim.** A modal claims the keyboard, and every other component can ask
 *    who holds it. The host asks before it answers Escape or Tab, and stands down
 *    while a modal holds the keyboard: Escape then cancels the modal instead of
 *    aborting the running turn, and Tab moves the modal's focus instead of cycling
 *    the session mode. Neither happened before — a modal that closed on Escape also
 *    aborted the turn, because the host's listener ran on the very same key.
 *  - **the lease.** A claim is a *lease*, not a flag: the host takes one for the
 *    single event it swallows (so blessed cannot hand Escape to the focused
 *    textarea, which would end its read), and a modal takes one for as long as it is
 *    open. The screen's lock is derived from the leases, so a lease is never
 *    released by a holder that did not take it — the bug a boolean lock has, where
 *    the host's one-event unlock frees a modal that is still open.
 *
 * **A lease is released on the next tick, not in the middle of the event that ended
 * it.** That is what makes the ownership total. The key that closed the modal is
 * still travelling through the program's listeners, and the modal is still the owner
 * of *that* key: the host must not also answer it, and blessed must not hand it to
 * the focused input box. So `releaseKeyboardLater()` is how a modal lets go — the
 * lease goes at the end of the event, not in the middle of it.
 *
 * The ledger is **per screen**: two screens can hold leases at the same time (a test
 * runs more than one), and the lock one screen carried before is restored to that
 * screen alone. A single global "previous lock" would restore the wrong screen's
 * lock and leave the other one locked for ever.
 *
 * Pure bookkeeping: no blessed, no screen, no terminal. The one impure act is
 * `applyKeyboardLock()`, which writes `screen.lockKeys`.
 */

/** The holder label a modal claims the keyboard under. */
export const KEYBOARD_OWNER_MODAL = 'modal';

/** The holder label the host's one-event lock is taken under. */
export const KEYBOARD_OWNER_EVENT = 'event';

/** Every live lease. */
const leases = new Set();

/** The lock each screen carried before any lease of ours took it. */
const previousLock = new WeakMap();

/** How many live leases each screen has. */
const screenLeases = new WeakMap();

/** The screens that already listen for their own destruction. */
const watchedScreens = new WeakSet();

/**
 * Take the keyboard, and get the token that releases it.
 *
 * @param {object} [options]
 * @param {object} [options.screen] the blessed screen the lock is written on
 * @param {string} [options.label] who is taking it (`modal`, `event`)
 * @returns {object} the token, to be passed to `releaseKeyboard()`
 */
export function claimKeyboard({ screen = null, label = KEYBOARD_OWNER_MODAL } = {}) {
  const token = { label: String(label), screen };
  leases.add(token);
  if (screen) {
    if (!screenLeases.has(screen)) {
      // The first lease of this screen remembers the lock it carried, so the lock can
      // be handed back to whoever had it.
      previousLock.set(screen, screen.lockKeys === true);
      screenLeases.set(screen, 0);
    }
    screenLeases.set(screen, screenLeases.get(screen) + 1);
    screen.lockKeys = true;
    // A lease must never outlive its screen: a modal whose screen was torn down
    // without being closed would otherwise hold the keyboard for ever, and the host
    // would stand down for a modal that no longer exists. The listener is attached
    // **once per screen**, not once per lease — the host takes a lease for every
    // interrupt, and a listener per lease would pile up on the screen for ever.
    if (typeof screen.on === 'function' && !watchedScreens.has(screen)) {
      watchedScreens.add(screen);
      screen.on('destroy', () => {
        for (const held of [...leases]) {
          if (held.screen === screen) releaseKeyboard(held);
        }
      });
    }
  }
  return token;
}

/**
 * Release one lease. A token that was never taken (or is released twice) is
 * ignored: the ledger must never go negative.
 *
 * @param {object} token the token `claimKeyboard()` returned
 * @returns {boolean} true when a lease was actually released
 */
export function releaseKeyboard(token) {
  if (!token || !leases.has(token)) return false;
  leases.delete(token);
  const { screen } = token;
  if (!screen) return true;

  const left = (screenLeases.get(screen) ?? 1) - 1;
  if (left > 0) {
    screenLeases.set(screen, left);
    return true;
  }
  // The last lease of this screen goes: the lock it carried before is restored.
  screenLeases.delete(screen);
  screen.lockKeys = previousLock.get(screen) === true;
  previousLock.delete(screen);
  return true;
}

/**
 * Release a lease at the **end of the current event**, not in the middle of it.
 *
 * This is how a modal lets go of the keyboard: the key that closed it is still
 * travelling through the program's listeners, and until they have all seen it the
 * modal is still its owner. Releasing here — rather than inside the handler that
 * closed the modal — is what keeps the host from also answering that key, and what
 * keeps blessed from handing it to the focused input box.
 *
 * @param {object} token the token `claimKeyboard()` returned
 * @param {Function} [options.defer] the scheduler, injectable for a test
 * @returns {boolean} true when a lease was actually scheduled for release
 */
export function releaseKeyboardLater(token, { defer = queueMicrotask } = {}) {
  if (!token || !leases.has(token)) return false;
  defer(() => releaseKeyboard(token));
  return true;
}

/**
 * Let the **mouse** through while the keyboard stays claimed.
 *
 * `screen.lockKeys` is one switch over two input channels: blessed returns from its
 * mouse dispatcher for the same flag that makes its key dispatcher stand down
 * (`lib/widgets/screen.js` — `_listenMouse`: `if (self.lockKeys) return;`, and
 * `_listenKeys`: the keypress handler returns while it is set). A modal that claims the
 * keyboard therefore also stops every mouse report reaching any widget. That is right for
 * the conversation *behind* it — nothing should respond under a modal — and wrong for the
 * modal itself, because a read-only viewer whose text cannot be selected cannot be copied
 * from (`docs/interface/clipboard-selection`).
 *
 * So the lock is made to mean what it is named: a *keyboard* lock. The mouse dispatcher is
 * left to its own hit-testing, and the regions behind the modal are safe under it for a
 * reason already in place — each one is created with `autoFocus: false` and answers no
 * drag of its own, so a report that reaches one does nothing. The one widget that acts on
 * the pointer is the modal's own box, which is the point.
 *
 * Blessed reads the flag on every report, so clearing it once is enough for as long as
 * nothing re-raises it; a caller that paints repeatedly may simply ask again.
 *
 * @param {object} [options]
 * @param {object} [options.screen] the screen whose lease is being relaxed
 * @returns {boolean} whether the flag was actually cleared
 */
export function unlockMouse({ screen = null } = {}) {
  if (!screen) return false;
  if (![...leases].some((token) => token.screen === screen)) return false;
  if (screen.lockKeys !== true) return false;
  screen.lockKeys = false;
  return true;
}

/** The labels of every live lease. */
export function keyboardHolders() {
  return [...leases].map((token) => token.label);
}

/** True while anybody holds the keyboard. */
export function keyboardHeld() {
  return leases.size > 0;
}

/**
 * True while somebody holds the keyboard under `label`.
 *
 * @param {string} label the holder label to look for
 * @returns {boolean} true when a lease with that label is live
 */
export function keyboardHeldBy(label) {
  const wanted = String(label);
  return [...leases].some((token) => token.label === wanted);
}
