# Keeping the input box armed

The backlog item this contract answers:

> sometimes the input box for the message looses focus and i cant make it come back
> there, so i cant write anything. clicking should work, and periodically just put
> the focus back in there

## The armed state

The input box is **armed** when two things are true at once:

1. it owns the screen's focus (`screen.focused === inputBox`), and
2. it is inside its read cycle (`inputBox._reading === true`).

Both halves are required. A box that owns the focus but is not reading swallows
every keystroke; a box that is reading but lost the focus never receives one. The
two facts are the same state, so `needsFocus()` treats "either half missing" as
"arm the box again".

The **listener** is a third fact, and it arrives a tick late. `readInput()` sets
`_reading = true` synchronously and installs the keypress listener from a
`nextTick` (`lib/widgets/textarea.js#Textarea`), so between the two there is a
window where the box is focused and reading but still deaf. That window is not a
bug and needs no repair: the scheduled tick always installs the listener, and the
flag is set before it so the read cannot be lost in between. It does mean that
"armed" is not readable from the two flags alone at an arbitrary instant — a
caller that must observe the whole state waits for the listener too, which is what
the periodic-check case does.

## Why the state is lost

The widget layer does two things that are individually reasonable and jointly
fatal:

- **A click autofocuses the clicked region.** blessed focuses every element that
  is `clickable` and has not opted out (`options.autoFocus !== false`), so a click
  on the transcript or the queue bar moved the focus there. The textarea's own
  `blur` handler then ended its read cycle: the keypress listener was removed and
  the box went quietly deaf.
- **Gaining the focus does not resume the read.** The box is created without
  blessed's `inputOnFocus`, because that option arms a second read on every focus
  and two listeners make every keystroke land twice. So the box has to be armed
  *by the code that owns the prompt*, not by the widget.

## The contract

1. **Clicking never takes the caret away.** The transcript and the queue bar stay
   clickable — a click still toggles a tool-result block and still deletes a queued
   message — but they opt out of blessed's autofocus (`autoFocus: false`). A click
   on either leaves the box focused, reading and accepting keystrokes.
2. **Clicking the box arms it.** The input box is clickable and its click is
   handled explicitly: the box is focused and its read restarted from any state.
   Arming is idempotent — `arm()` only focuses when the box does not already own
   the focus and only starts a read when one is not already running — so clicking
   an armed box changes nothing and never leaves two keypress listeners behind.
3. **A lost focus is repaired periodically.** `createFocusGuard()` checks the armed
   state once per `FOCUS_CHECK_INTERVAL_MS` (1000 ms) and re-arms the box when it
   drifted. The timer is `unref`'d, so a watchdog can never hold the process open.
   A repair is counted, so a host or a test can tell a repair from a no-op.
4. **The guard only acts when the box should be armed.** It stands down unless the
   host's `hold` rule says a question is armed or a turn is in flight, and it stands
   down while `screen.lockKeys` is set — a modal owns the keyboard then and its own
   hand-back focuses the box. A watchdog that armed the box underneath a modal would
   fight it.
5. **Teardown leaves nothing behind.** Closing the guard clears the timer and
   detaches the click listener; a closed guard never arms the box again.

## Not this contract

- The box's content, hint, submission and queueing rules (`app/prompt-input.js`,
  `docs/interface/tui`).
- The transcript block toggling and the queue-row deletion a click performs
  (`docs/interface/transcript-blocks`, `docs/interface/message-queue`).
- The modal's own focus hand-back (`app/tui-modal.js`).

## Edge cases

- A click on a hidden region cannot happen: blessed skips elements without a
  position, so the queue bar only receives clicks while it is on screen.
- A click on the box while a modal is open is ignored by the guard, because the
  modal owns the keyboard. Since `unlockMouse()`
  (`app/keyboard-ownership.js`, `docs/interface/clipboard-selection`) a *viewer* modal
  grants the mouse back while keeping the keyboard, so the pointer does reach the
  regions behind it — the guard still stands down, and what it would have protected is
  covered by the fact that arming is idempotent and a click on an already-armed box
  changes nothing.
- A box that is already armed is not focused again: focusing an element that
  already owns the focus emits a `blur` on it and would end the read it is holding.
- A check that lands in the tick between `_reading = true` and the listener being
  installed sees a deaf box and arms it again; `arm()` is idempotent and
  `readInput()` returns early while a read is live, so the repair costs nothing and
  leaves one listener. A test that asserts the listener count must wait for the
  whole armed state rather than the focus alone, or it reads the count mid-install.
