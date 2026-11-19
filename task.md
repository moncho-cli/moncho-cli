status: done

# Input box focus: a click must not take the caret away, and the focus comes back by itself

The backlog item:

> sometimes the input box for the message looses focus and i cant make it come back
> there, so i cant write anything. clicking should work, and periodically just put the
> focus back in there

- [x] sometimes the input box for the message looses focus and i cant make it come back there, so i cant write anything. clicking should work, and periodically just put the focus back in there

## What is actually wrong

Reproduced on the real TUI with the mouse events the blessed program emits for a
real click (a one-off probe, since deleted; the proof lives in `tests/`):

| Step | `screen.focused` | `inputBox._reading` | keypress listeners | typing |
| ---- | ---------------- | ------------------- | ------------------ | ------ |
| after `question('> ')` | `inputBox` | `true` | 1 | lands, once |
| after a click on the transcript | `log` | `false` | 0 | **dropped** |
| after a click on the input box | `log` | `false` | 0 | **dropped** |

Two causes, both in the widget layer rather than in our own handlers:

1. **A click autofocuses the clicked region.** blessed binds
   `screen.on('element click', el => el.focus())` for every `clickable` element
   whose `options.autoFocus !== false` (`lib/widgets/screen.js#Screen`), and the
   transcript (block toggle) and the queue bar (delete row) are both `clickable`.
   Focusing the transcript blurs the input box, and the textarea's own
   `this.on('blur', this.__done)` handler **ends the read cycle**: the keypress
   listener is removed and `_reading` goes false
   (`lib/widgets/textarea.js#Textarea`). The armed `question()` promise is never
   settled, so the host loop also waits forever.
2. **The input box cannot be clicked back into focus.** A `blessed.textbox` is not
   `clickable` unless it is asked to be, so there is no click path back to the box,
   and focusing alone would not resume the read anyway (no `inputOnFocus`).

## The fix

| Piece | What it does |
| ----- | ------------ |
| `app/focus-guard.js` | `needsFocus()` (one honest question: does the box own the focus *and* is it reading?) and `createFocusGuard()`: focus the box and re-arm its read when the answer is no, stand down while `screen.lockKeys` says a modal owns the keyboard, and run that check on an unref'd timer — the "periodically just put the focus back in there" clause. |
| `app/tui-layout.js` | `autoFocus: false` on the transcript and the queue bar, so a click there toggles/deletes and *never* moves the caret; `clickable: true, autoFocus: false` on the input box, so it can be clicked. |
| `app/tui.js` | a click on the input box re-arms it (`promptInput.arm()`), the guard is created with `hold: () => armed or in flight`, started, closed with the screen, and exposed on the surface. |
| `app/prompt-input.js` | an `isReading` view of the box's read cycle, so the guard can tell a healthy box from a silently-killed one without reaching into blessed's privates in two places. |

## Done when — verified

- [x] a click on the transcript or the queue bar leaves the input box focused,
      reading and accepting keystrokes — proven on the real TUI with mouse events on
      the program (`tests/input-focus.test.js`).
- [x] clicking the input box focuses it and re-arms its read from any state, and a
      keyboard drift is repaired by the watchdog within one interval while a question
      is armed; the guard stands down while a modal holds the keys.
- [x] `docs/interface/input-focus` states the contract and `docs/index.yaml`
      registers it, so `tests/docs-realm.test.js` passes.
- [x] `npm test` is green, every touched file is under 300 lines, and the one-off
      probe is deleted once it has answered its question.

## Files

| Action | Path |
| ------ | ---- |
| added | `app/focus-guard.js`, `tests/input-focus.test.js`, `docs/interface/input-focus/*` |
| edited | `app/tui-layout.js` (clickable + `autoFocus: false`), `app/tui.js` (the guard, the box click), `app/prompt-input.js` (`isReading`), `app/tui-surface.js` (the guard view), `docs/index.yaml`, `tests/README.md` |
| deleted | `agent/utils/probe-input-focus.mjs` |
