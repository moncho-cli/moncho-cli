status: done

# Queue preview: a row must use the width it actually has

The backlog item:

> the messages in queue get strangely truncated, too soon, i cant read whats there,
> idk if its will be sent properly

- [x] the messages in queue get strangely truncated, too soon, i cant read whats there, idk if its will be sent properly

## What was actually wrong

Two display bugs in the same row, both from one cause: the row formatter did not know
how wide it was.

| Symptom | Cause |
| ------- | ----- |
| "too soon" | `previewMessage()` capped every preview at `QUEUE_PREVIEW_CHARS` (48) however wide the terminal was, so an 80-column bar (78 usable cells) threw away 25 of them, and a 120-column one threw away 65. |
| "strangely truncated" | the bar passed the *number of rows* to `setQueueHeight`, not the number of *display lines*: a row wider than the box wrapped onto a second line and neo-blessed clipped it at the height it was given — so the end of the message vanished with **no `…` at all**. Measured in the probe: at 50 and 30 columns the row was 53 cells long, painted as 2 lines in a 1-row region, `clipped: true`. |

The message itself was **never** damaged: the queue keeps it verbatim, so what is
injected is exactly what was typed. Only the *preview* was wrong — which is precisely
why the user could not tell what would be sent.

## The fix

A row now knows one number about the screen — the interior width the bar offers, in
**cells** — and is fitted to it.

| Piece | What it does |
| ----- | ------------ |
| `app/queue-rows.js` | the row view: `displayWidth` / `truncateToWidth` count **cells** (a wide glyph two, a combining mark none), `queuePreviewBudget` takes the `✕ N. ` prefix off the budget so the marker and position always survive, and `formatQueueRow`/`formatQueueRows` fit every preview to one row. |
| `app/message-queue.js` | unchanged model: the order, the verbatim bytes and the click geometry stay here, and the row view is re-exported (`export * from './queue-rows.js'`) so every existing import keeps working. |
| `app/queue-bar.js` | passes the width to the rows, re-read on every paint; exposes `columns` (the interior width in use). |
| `app/tui.js` | `columns: () => screen.width - 2` — the widget's own two columns of padding — and a resize now repaints the queue so the previews are re-fitted to the new window. |

The width budget lives in a **new module** rather than in `app/message-queue.js`
because that file would otherwise have crossed the 300-line budget (it is now 152
lines, `app/queue-rows.js` is 139): the model is the queue, the row is the view of it.

## Done when — verified

- [x] a long queued message uses the whole width of the bar: `formatQueueRow` returns
      exactly 118 cells of row on a 120-column screen, 78 on an 80-column one
      (`tests/queue-rows.test.js`, `tests/message-queue-tui.test.js`).
- [x] no painted row exceeds the box, and the region height matches the rows painted:
      each row is one display line, `queueBar.getScreenLines().length === 1`, and the
      whole screen is 316 pass / 0 fail.
- [x] `docs/interface/message-queue` states the width rule (a new *the row is fitted to
      the width it really has* section) and `spec.yaml` links the new module and cases,
      so `tests/docs-realm.test.js` passes.
- [x] `npm test` is green — **316 pass / 0 fail** — every touched file is under 300
      lines (longest: `app/tui.js`, 273), and the one-off probe
      (`agent/utils/probe-queue-row-width.mjs`) was deleted once it had answered its
      question.

## Files

| Action | Path |
| ------ | ---- |
| added | `app/queue-rows.js`, `tests/queue-rows.test.js` |
| rewritten | `app/queue-bar.js` (the `columns` accessor and its surface view) |
| edited | `app/message-queue.js` (the row view re-exported), `app/tui.js` (the width accessor, the resize repaint), `tests/message-queue.test.js`, `tests/message-queue-tui.test.js`, `docs/interface/message-queue/*`, `tests/README.md` |
| deleted | `agent/utils/probe-queue-row-width.mjs` |
