# Interface — the TUI

When stdout is a TTY the agent runs inside a full-screen terminal UI built on
neo-blessed. This spec fixes the layout, the rendering rules and the TUI-only
extras; the implementation is linked below.

## Layout

Five regions, laid out relatively so blessed relayouts them on resize:

| Region | Position | Purpose |
| ------------- | --------------------------- | ----------------------------------------- |
| input box | bottom 0, height 3 | the prompt the user types into |
| status bar | bottom 3, height 1 | status text, spinner, or the token meter |
| model row | bottom 4, height 1 | provider · model label, resolved at startup |
| transcript | bottom 5 up to the top | scrollable, bordered conversation log |

- **Without a TTY `createTui()` returns `null`** (e.g. the detached
  `start.sh start` run), and the host falls back to the line CLI. It must never
  throw when there is no pty.
- A mid-session resize repaints and keeps the newest line in view.

## Rendering

- All model text passes through a **sanitiser** first: ANSI escape sequences and
  control characters are stripped so raw model output cannot break rendering, and
  braces are escaped because blessed reads `{…}` as tags.
- `log()` splits multi-line text and writes one transcript row per line.
- A small markdown-ish renderer colours fenced code blocks, `<file …>` delimiters,
  headings, lists, bold and inline code. It is pure (no screen needed) so it can be
  unit tested.
- A long paste collapses into a single `[[paste:<id>]]` tag and expands back
  **byte-for-byte**, so collapsing never alters the bytes the model receives.
- The status bar doubles as the context meter: the token usage string (and the
  configured-vs-real label appended by the window) is painted there.
- A compaction that fires while the request is in flight is announced in the
  transcript — the status bar is owned by the spinner at that moment — exactly once
  per event.

## Status and feedback

- While a request is in flight the status bar shows an animated spinner frame; the
  last logical status text is restored when the reply lands, and stopping the
  spinner never leaves a frame behind (including after an abort).
- `setTokens()` accepts the usage string the host passes from
  `onContextChange`, so the meter is driven by real window stats.

## Scrolling

- The transcript scrolls even while the input box owns focus: page-up/page-down
  (and shift-up/down), home and end work from the keyboard, and a direct
  `scrollBy()` is exposed for tests.

## See also

- Implementation: `app/tui.js`, `config/constants.js`
- Proof: `tests/tui.test.js`, `tests/interrupt-controls.test.js`
