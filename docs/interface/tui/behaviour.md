# Interface — the TUI

When stdout is a TTY the agent runs inside a full-screen terminal UI built on
neo-blessed. This spec fixes the layout, the rendering rules and the TUI-only
extras; the implementation is linked below.

## Layout

Six regions, laid out relatively so blessed relayouts them on resize:

| Region | Position | Purpose |
| ------------- | --------------------------- | ----------------------------------------- |
| input box | bottom 0, height 3 | the prompt the user types into |
| queue bar | bottom 3, height 0..n | pending messages, one `✕` row each; hidden while empty |
| status bar | bottom 3 + queue height | status text/spinner on the left, token meter on the right |
| model row | bottom 4 + queue height | provider · model label, resolved at startup |
| transcript | bottom 5 + queue height up to the top | scrollable, bordered conversation log |

- The queue bar is the only region whose size changes: `setQueueHeight(rows)` makes
  room for the pending messages right above the input box — the status bar, the
  model row and the transcript shift up by that many rows — and at 0 it hides the
  region and restores every base anchor, so an empty queue costs no row. The rules
  it serves live in `docs/interface/message-queue`.
- **Without a TTY `createTui()` returns `null`** (e.g. the detached
  `start.sh start` run), and the host falls back to the line CLI. It must never
  throw when there is no pty.
- A mid-session resize repaints the status row (re-pinning the meter to the new
  right edge) and keeps the newest transcript line in view.
- The region layout lives in `createLayout()` (`app/tui-layout.js`), so the
  orchestration in `app/tui.js` stays about keys, questions and the public surface.
- The input box is **armed by `question()` alone**. The region is created without
  blessed's `inputOnFocus`, so gaining focus (e.g. when the picker modal closes)
  never starts a read of its own; two overlapping read cycles would leave the box
  with two `keypress` listeners and every typed character would land twice. The one
  other arming point is the re-arm after a *queued* submission
  (`docs/interface/message-queue`), which runs on the next tick for the same reason.

## Rendering

- All model text passes through a **sanitiser** first: ANSI escape sequences and
  control characters are stripped so raw model output cannot break rendering, and
  braces are escaped because blessed reads `{…}` as tags.
- `log()` splits multi-line text and writes one transcript row per line.
- A small markdown-ish renderer colours fenced code blocks, tool delimiters,
  headings, lists, bold and inline code. It is pure (no screen needed) so it can be
  unit tested. Every discovery/read tool has a delimiter branch: `<file …>` (path +
  line range), `<grep …>` (pattern, path, match/file counts), `<blobs …>` / `<blob …>`
  (path, byte and line counts, `skipped` markers), and each carries its `truncated`
  flag into the header instead of printing the raw tag.
- A long paste collapses into a single `[[paste:<id>]]` tag and expands back
  **byte-for-byte**, so collapsing never alters the bytes the model receives.
- The transcript is a model of plain lines and **collapsible blocks**: a tool
  result starts as one header line carrying its `X char response` size, and a click
  expands it (the next click collapses it) without touching the payload. The rules
  live in `docs/interface/transcript-blocks`.
- The user's own message is part of the transcript too, echoed as a `You:` header
  plus one quoted line per message line (`docs/interface/user-messages`).
- The status bar is one row with two slots: the logical status text (or the
  spinner frame) starts at the left edge and the **context meter is pinned to the
  right edge** — the token usage string plus the configured-vs-real label the
  window appends. `composeStatusRow()` lays the row out purely, and when the width
  is too small the left text is truncated, never the meter.
- A compaction that fires while the request is in flight is announced in the
  transcript — the status bar is owned by the spinner at that moment — exactly once
  per event.
- The **kind** of each row is coloured too: the echoed prompt, tool calls and
  results, context notices and errors each get their own colour, while a line the
  markdown renderer already coloured is left as it is and prose keeps the terminal
  default. The palette and its rules live in `docs/interface/conversation-colors`.
- `reload(chunks)` replaces the whole transcript with a stored conversation: the
  view is emptied and the session replayed into it as lines and collapsible blocks
  (`docs/interface/session-replay`), so opening a session shows it as it was left.

## Status and feedback

- While a request is in flight the status bar shows an animated spinner frame; the
  meter keeps painting alongside it, the last logical status text is restored when
  the reply lands, and stopping the spinner never leaves a frame behind (including
  after an abort).
- `startSpinner()` is also what opens the in-flight state of the input box: the box
  stays armed for the whole turn, so a message typed then is queued rather than
  lost (`docs/interface/message-queue`). `stopSpinner()` closes that state again.
- `setTokens()` accepts the usage string the host passes from
  `onContextChange`, so the meter is driven by real window stats; a mid-request
  update repaints at once instead of being swallowed by the spinner.
- The manager announces every window change (`docs/context/usage-refresh`), so the
  meter climbs chunk by chunk during a tool chain instead of jumping when the turn
  ends.

## Scrolling

- The transcript scrolls even while the input box owns focus: page-up/page-down
  (and shift-up/down), home and end work from the keyboard, a mouse wheel notch
  over the transcript nudges it a few rows, and a direct `scrollBy()` is exposed
  for tests. How far each gesture moves is fixed by
  `docs/interface/transcript-smooth-scroll`.
- Arriving output only scrolls the view when the reader is parked at the bottom; a
  reader who scrolled up keeps the offset they chose. The rule and the geometry it
  reads are fixed by `docs/interface/transcript-scroll`.

## See also

- Implementation: `app/tui.js` (screen wiring), `app/tui-layout.js` (regions),
  `app/tui-render.js` (pure text helpers), `app/tui-keys.js` (key bindings),
  `app/paste-registry.js` (the paste table), `app/compaction-notice.js` (the
  once-per-event compaction line), `app/status-row.js` (status/spinner/meter
  bookkeeping), `app/tui-modal.js` (the picker modal and its `choose` surface),
  `app/prompt-input.js` (the armed-question / queueing box), `config/constants.js`
- Spec of the pending-message queue above the input box: `docs/interface/message-queue`
- Spec of the scroll position while output arrives: `docs/interface/transcript-scroll`
- Spec of the wheel and page steps: `docs/interface/transcript-smooth-scroll`
- Spec of the conversation palette: `docs/interface/conversation-colors`
- Spec of the reload when a session is resumed: `docs/interface/session-replay`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Proof: `tests/tui.test.js`, `tests/tui-render.test.js`, `tests/tui-status.test.js`,
  `tests/tui-modules.test.js`,
  `tests/transcript-blocks.test.js`, `tests/transcript-scroll.test.js`,
  `tests/transcript-smooth-scroll.test.js`, `tests/interrupt-controls.test.js`
