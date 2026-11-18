# Interface — scrolling through the conversation

The transcript is the widget the user reads, and scrolling it used to be the one
thing it could not do well: a mouse wheel over it moved nothing at all, and a
page-up jumped a single row. This spec fixes the steps; the follow/hold rule for
*arriving* output stays where it is (`docs/interface/transcript-scroll`).

## The gap that was fixed

- `createLayout()` marks the transcript `clickable: true` (the block toggle needs
  clicks) but never `mouse: true`, and neo-blessed only binds `wheelup`/`wheeldown`
  when `mouse: true`. A wheel over the transcript therefore reached no listener:
  measured on the shipped widget, a notch moved **0 rows**.
- Page-up/page-down were bound to `transcript.scroll(±1)`, i.e. one row per press,
  and `home`/`end` jumped to a percentage. Nothing moved by a screenful.
- Every step went through `transcript.scroll()`, which is fine, but the widget's
  own `mouse: true` wheel handler would have moved `height / 2` rows *and* enabled
  scrollbar dragging — a step the view cannot control, on a widget whose click is
  already taken by the block toggle. The wheel is bound by the view instead.

## The steps

Two distances, both derived from the widget's geometry:

| Gesture | Step |
| -------------------- | ---------------------------------------------------------- |
| mouse wheel notch | `WHEEL_STEP_ROWS` (3) rows towards / away from the bottom |
| page-up / page-down | `pageStepRows(visibleHeight)` = screenful − 1, at least 1 |

- `pageStepRows()` is pure: `floor(visible) - 1` for a visible height above 1, and
  `1` otherwise. One row short of a screenful means the last row of a page is the
  first row of the next, so paging through a long result never skips a line; a
  widget that has not been laid out yet still steps one row instead of zero, and
  junk geometry is not a crash.
- `scrollRows(delta)` moves by whole rows (positive = towards the bottom) and
  reports whether the view really moved. Clamping is blessed's: the view can never
  be scrolled past the first or the last row, so `scroll(-1)` at the top and
  `scroll(1)` at the bottom are no-ops rather than errors.
- `scrollPage(direction)` is `scrollRows(direction < 0 ? -step : +step)`.
- Home and End keep their existing behaviour (jump to the first / last row).

## A scroll is not a repaint

- The transcript widget is a pure function of the model, so a *content* change
  (`log()`, `logBlock()`, a toggle) re-sets the whole content and re-wraps every
  line.
- A scroll does **not**: `scrollRows()` only moves the viewport, so a wheel notch
  or a page costs one viewport move instead of re-parsing the entire transcript.
  Rebuilding the content on every step is what made the steps feel like a stutter.
- The decision is observable: a scroll never calls `setContent()`.

## Interaction with the follow rule

- The wheel and the page keys only move the viewport; they never change the model,
  so `isFollowingScroll()` reads the resulting position like any other scroll. A
  notch away from the bottom is "reading history": an arriving message then holds
  the offset instead of dragging the view down.
- Paging back to the end (End, or enough page-downs) resumes following, exactly as
  before.

## Who binds what

- `app/transcript-view.js` owns both steps and binds `wheelup`/`wheeldown` on the
  widget itself (and detaches them on `close()`).
- `app/tui.js` binds the keys — `pageup`/`S-up`, `pagedown`/`S-down`, `home`,
  `end` — on the screen, so they work while the input box owns the focus, and
  routes them through the view's steps. `scrollBy()` remains the row-wise entry
  point the tests drive.

## See also

- Implementation: `app/transcript-view.js`, `app/tui.js`
- Spec of the position while output arrives: `docs/interface/transcript-scroll`
- Spec of the surrounding screen: `docs/interface/tui`
- Proof: `tests/transcript-smooth-scroll.test.js`
