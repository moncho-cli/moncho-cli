# Input box focus: a click must not take the caret away, and the focus comes back by itself

status: done

## Result

The backlog item is done and proven. `app/focus-guard.js` keeps the input box
**armed** — owning the screen's focus *and* inside its read cycle — by three means:
the transcript and the queue bar no longer autofocus on click, a click on the box
itself re-arms it, and a 1 s unref'd watchdog re-arms it when it drifted. The guard
stands down while a modal owns the keyboard and while nothing is armed or in flight.

## Steps

- [x] Reproduce the bug on the real TUI (a one-off probe under `agent/utils/`,
      since deleted) and pin the two causes: blessed's click autofocus, and a
      `blur` that ends the read cycle with no path back.
- [x] Add `app/focus-guard.js`: `needsFocus()`, `createFocusGuard()` (unref'd timer,
      stand-down on `lockKeys` and on a `hold` rule) and `bindFocusGuard()`.
- [x] Wire it in: `autoFocus: false` on the transcript and the queue bar,
      `clickable: true, autoFocus: false` on the box, the guard created/started/closed
      in `app/tui.js` and exposed on the surface; `arm()` made idempotent.
- [x] Prove it: `tests/input-focus.test.js` drives the real TUI with program-level
      mouse events and asserts the box keeps focus, keeps reading and keeps accepting
      keystrokes; a keyboard drift is repaired by the watchdog.
- [x] Document it: `docs/interface/input-focus` (behaviour.md + spec.yaml),
      `docs/index.yaml` and `tests/README.md`.
- [x] Verify: `node --check` on every touched file, `npm test` green including
      `tests/docs-realm.test.js`, every file under 300 lines, then delete the probe.

## Verification

- `npm test` — 323 tests, 323 pass, 0 fail (was 316/0 before the new suite).
- `node --test tests/input-focus.test.js` — 7/7 pass.
- `node --test tests/docs-realm.test.js` — 5/5 pass, so the spec is registered, its
  code refs resolve and `app/focus-guard.js` is covered.
- Largest touched file: `app/tui.js` at 289 lines; `tests/input-focus.test.js` 278.
- `agent/utils/probe-input-focus.mjs` deleted (its question is answered by the suite).
