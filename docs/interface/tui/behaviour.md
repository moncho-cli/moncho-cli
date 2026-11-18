# Interface — the TUI

When stdout is a TTY the agent runs inside a full-screen terminal UI built on
neo-blessed. This spec fixes the layout, the rendering rules and the TUI-only
extras; the implementation is linked below.

## Layout

Five regions, laid out relatively so blessed relayouts them on resize:

| Region | Position | Purpose |
| ------------- | --------------------------- | ----------------------------------------- |
| input box | bottom 0, height 3 | the prompt the user types into |
| status bar | bottom 3, height 1 | status text/spinner on the left, token meter on the right |
| model row | bottom 4, height 1 | provider · model label, resolved at startup |
| transcript | bottom 5 up to the top | scrollable, bordered conversation log |

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
  with two `keypress` listeners and every typed character would land twice.

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
- The status bar is one row with two slots: the logical status text (or the
  spinner frame) starts at the left edge and the **context meter is pinned to the
  right edge** — the token usage string plus the configured-vs-real label the
  window appends. `composeStatusRow()` lays the row out purely, and when the width
  is too small the left text is truncated, never the meter.
- A compaction that fires while the request is in flight is announced in the
  transcript — the status bar is owned by the spinner at that moment — exactly once
  per event.

## Status and feedback

- While a request is in flight the status bar shows an animated spinner frame; the
  meter keeps painting alongside it, the last logical status text is restored when
  the reply lands, and stopping the spinner never leaves a frame behind (including
  after an abort).
- `setTokens()` accepts the usage string the host passes from
  `onContextChange`, so the meter is driven by real window stats; a mid-request
  update repaints at once instead of being swallowed by the spinner.

## Scrolling

- The transcript scrolls even while the input box owns focus: page-up/page-down
  (and shift-up/down), home and end work from the keyboard, and a direct
  `scrollBy()` is exposed for tests.

## See also

- Implementation: `app/tui.js` (screen wiring), `app/tui-layout.js` (regions),
  `app/tui-render.js` (pure text helpers), `app/status-row.js`
  (status/spinner/meter bookkeeping), `config/constants.js`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Proof: `tests/tui.test.js`, `tests/tui-status.test.js`,
  `tests/transcript-blocks.test.js`, `tests/interrupt-controls.test.js`
