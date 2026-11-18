# the messages in queue get strangely truncated, too soon, i cant read whats there, idk if its will be sent properly

status: done — every step verified

## Steps

- [x] Confirm the two bugs in the real TUI with a scratch probe in agent/utils/ (a long queued message on a wide fake TTY: measure the painted row width against the box width and what blessed clips).
- [x] Add the width budget to app/message-queue.js: previewMessage/formatQueueRow/formatQueueRows take `columns` and truncate to fit one row, keeping the `✕ N. ` prefix and the 48-char fallback when no width is known.
- [x] Pass the real width down: app/queue-bar.js takes a `columns` accessor, app/tui.js wires it to the screen, and the row height stays equal to the rows painted.
- [x] Prove it: new cases in tests/message-queue.test.js (budget, one row per message, fallback) and tests/message-queue-tui.test.js (a long message uses the whole bar and is never clipped).
- [x] Update docs/interface/message-queue (behaviour.md + spec.yaml case names) and tests/README.md if a suite description moved.
- [x] Verify: node --check on every touched file, npm test green including tests/docs-realm.test.js, every file under 300 lines, then delete the scratch probe.
