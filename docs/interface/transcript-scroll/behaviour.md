# Interface — transcript scrolling while output arrives

Messages arrive while the user is reading. The transcript must not drag the view
to the bottom when the reader scrolled up to look at something, and it must keep
following when the reader is parked at the end. This spec fixes that rule, the
geometry it reads and how it composes with the block toggle; the implementation is
linked below.

## The rule

`isFollowingScroll()` decides, from three numbers alone, whether an append may
scroll the view to the bottom:

| State | Decision |
| ------------------------------- | -------- |
| parked at the bottom | **follow** — the newest line comes into view |
| scrolled up (reading history) | **hold** — the chosen offset survives the append |
| nothing to scroll yet | **follow** — a short transcript keeps following as it grows |

"Parked at the bottom" is a percentage at or above `FOLLOW_BOTTOM_PERCENT`
(99.5), not an exact 100: blessed positions the view at the very end by several
routes (End, the mouse, a resize) and a one-row rounding difference must not be
read as "the reader scrolled up". The tolerance only matters when there is
something to scroll — a widget with no measured height yet, or content that
already fits, always follows, because no offset has been chosen that could be
lost. A non-numeric percentage is treated as "not at the bottom", never as a
crash.

## The view

`app/transcript-view.js` applies the rule on every repaint, so every append path
(`log()`, `logBlock()`, a resumed session, a tool result) behaves the same way:

- the decision is taken **before** the content changes, using the widget's current
  offset and geometry;
- the view owns the scroll position: blessed's log widget jumps to the bottom on
  every content change, which is exactly the behaviour being fixed, so that
  automatic jump is suppressed and the position is set explicitly afterwards;
- the same decision is re-asserted on blessed's own tick, because a repaint and
  blessed's handler can be queued together — the last paint wins, regardless of
  the order the handlers run in;
- `paint({ keepScroll })` overrides the rule: `true` forces the hold, `false`
  forces the follow. A block toggle always passes `true`, so expanding or
  collapsing a result above the fold keeps the offset
  (`docs/interface/transcript-blocks`).
- `isFollowing()` reports the current decision, so the host and the tests can
  observe it without touching the rule.

## Keyboard scrolling

Holding the offset never breaks the bindings: page-up/page-down, home and end keep
working while the input box has focus, and starting a scroll after a held append
moves the view from where the reader left it.

## See also

- Implementation: `app/transcript-view.js`
- The transcript widget it binds: `docs/interface/transcript-blocks`
- Spec of the surrounding screen: `docs/interface/tui`
- Proof: `tests/transcript-scroll.test.js`
