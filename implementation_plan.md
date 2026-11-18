# TUI conversation window: smooth scrolling and readable colours

status: done

## Steps

- [x] Probe the real widget and record the gap: a wheel notch over the transcript moved 0 rows (the widget is `clickable: true` but not `mouse: true`, and neo-blessed binds `wheelup`/`wheeldown` only with `mouse: true`); page-up stepped a single row.
- [x] Add the steps as pure arithmetic in `app/transcript-view.js`: `WHEEL_STEP_ROWS` (3) and `pageStepRows(visible)` = screenful − 1 (at least 1), plus `scrollRows()`/`scrollPage()` that move the viewport only (never `setContent()`), and bind `wheelup`/`wheeldown` on the widget.
- [x] Route the TUI keys through the view in `app/tui.js` (page-up/page-down a page, home/end unchanged) and expose `scrollPage`/`transcriptView`.
- [x] Write `docs/interface/transcript-smooth-scroll` (behaviour.md + spec.yaml), register it in `docs/index.yaml` and cross-reference it from `transcript-scroll` and `tui`.
- [x] Prove it in `tests/transcript-smooth-scroll.test.js` (5 cases, real TUI on the fake TTY).
- [x] Split `app/tui.js` back under the line budget by extracting `app/tui-keys.js` (key bindings), `app/paste-registry.js` (the paste table) and `app/compaction-notice.js` (the once-per-event compaction line), with `tests/tui-modules.test.js` proving each.
- [x] Add the palette as a pure module `app/theme.js`: one colour per kind of row (user, tool, context, error, notice), `classifyLine()`/`colorizeLine()`/`colorizeLines()`, applied at the end of `formatTranscript()` so already-coloured markdown lines and plain prose are untouched.
- [x] Verify nested tags are safe (neo-blessed restores the outer colour after an inline `**bold**`/`` `code` `` span) and that the tag adds no visible width, so the block-click row math still lands.
- [x] Write `docs/interface/conversation-colors` (behaviour.md + spec.yaml), register it in `docs/index.yaml` and cross-reference it from `tui` and `user-messages`.
- [x] Prove it in `tests/conversation-colors.test.js` (8 cases, including the colour really reaching the terminal frame).
- [x] Delete the one-off probes, run `npm test` (212 cases green, `tests/docs-realm.test.js` included) and `node --check` on every file touched; no file exceeds 300 lines.

## Notes

- Both backlog items are ticked in `task-backlog.md`.
- Colour and scroll position stay presentation only: no tag or offset reaches the model context or the session file, and the line CLI (which never calls `formatTranscript()`) can never print one.
