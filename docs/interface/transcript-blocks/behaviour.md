# Interface — collapsible tool output

Tool results are the bulkiest thing in the conversation, and most of the time the
user does not read them. The TUI therefore renders each tool result as a
**collapsible block**: one header line by default, expanded on a click and
collapsed again on the next one. This spec fixes that behaviour; the
implementation is linked below.

## The model

`app/transcript.js` holds the transcript as an ordered list of entries, with no
terminal widget involved (pure, so every rule here is unit testable):

- a **plain line** — prose, notices, tool-call headers — which may carry the
  **role** of the side of the dialogue it belongs to (`user` / `assistant`), the one
  thing the prose band is painted from (`docs/interface/prose-bands`);
- a **block** — one header line plus the payload (`body`, stored verbatim) and the
  formatted `bodyLines` actually painted.

- A block starts **collapsed** when it spans several lines or exceeds
  `COLLAPSE_THRESHOLD_CHARS` characters, so tool output is collapsed "most of the
  times" while a one-word result stays readable inline.
- The collapsed header ends with the size of the payload, `X char response`
  (`formatCharCount()`), so the user can tell how much is hidden before clicking.
- Collapsed blocks paint exactly one display line; expanding paints the header
  plus the payload. `rangeOf()`/`blockAtLine()` map display lines back to blocks,
  and toggling never alters `body`.

## The view

`app/transcript-view.js` binds the model to a blessed scrollable widget:

- `log()` appends plain lines, `logProse(role, text)` appends one side of the
  dialogue (banded, `docs/interface/prose-bands`), `logBlock()` appends a collapsible
  block; all three repaint from the model, so the widget is a pure function of the
  model.
- Rendering (sanitising, tag escaping, markdown colouring) happens in
  `formatTranscript()` (`app/tui-render.js`); the model stays plain text.
- A click resolves through `blockAtClick()` — the screen row, the widget's
  border/padding and its scroll base (`childBase`), then blessed's wrapped-line
  table (`rtof`) — to the block under the cursor, and toggles it. A click that
  lands on prose, or outside the widget, changes nothing.
- Toggling keeps the scroll offset, so expanding a block above the fold does not
  yank the transcript to the end.

## The host

`main.js` routes every tool result through `tui.logBlock({ header, body })` when
the TUI is active — the header keeps the call's intent, exactly as the line CLI
prints it — and falls back to plain `log()` lines without a pty.

## See also

- Implementation: `app/transcript.js`, `app/transcript-view.js`, `main.js`
- Spec of the surrounding screen: `docs/interface/tui`
- Proof: `tests/transcript-blocks.test.js`
