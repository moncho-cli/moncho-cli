# Interface — the TUI

When stdout is a TTY the agent runs inside a full-screen terminal UI built on
neo-blessed. This spec fixes the layout, the rendering rules and the TUI-only
extras; the implementation is linked below.

## Layout

Seven regions, laid out relatively so blessed relayouts them on resize:

| Region | Position | Purpose |
| ------------- | --------------------------- | ----------------------------------------- |
| input box | bottom 0, height 3 | the prompt the user types into |
| queue bar | bottom 3, height 0..n | pending messages, one `✕` row each; hidden while empty |
| status bar | bottom 3 + queue height | status text/spinner on the left, token meter on the right |
| working-time row | bottom 4 + queue height | the counter right-aligned against the meter's own column (`docs/context/working-time`) |
| model row | bottom 5 + queue height | the session's mode label, then provider · model, resolved at startup |
| transcript | bottom 6 + queue height up to one row below the top | scrollable, bordered conversation log |

- The queue bar is the only region whose size changes: `setQueueHeight(rows)` makes
  room for the pending messages right above the input box — the status bar, the
  working-time row, the model row and the transcript shift up by that many rows —
  and at 0 it hides the region and restores every base anchor, so an empty queue
  costs no row. The rules it serves live in `docs/interface/message-queue`.
- **Without a TTY `createTui()` returns `null`** (e.g. the detached
  `start.sh start` run), and the host falls back to the line CLI. It must never
  throw when there is no pty.
- A mid-session resize repaints the status row (re-pinning the meter to the new
  right edge) and keeps the newest transcript line in view.
  Every row fitted to a width — the queue previews, the brand line and the notices
  that follow it — is re-fitted at the new width as well, and the teardown releases
  the regions in reverse construction order exactly once; both sequences live in
  `app/tui-teardown.js`, so `app/tui.js` stays the wiring.
- The resize listener **paints the screen once more after the re-fit**, because blessed
  renders the screen and only then emits `resize` (`screen.js`: `alloc()`, `render()`,
  then the event). A listener that only re-fits leaves its work unpainted until the next
  frame, and the frame in between is the all-black flash the backlog reports
  ("resizing the window makes the tui be all black for a moment"). Painting closes that
  gap; the closed-screen latch (`app/tui-screen.js`) keeps a destroyed screen from being
  rendered.
- The region layout lives in `createLayout()` (`app/tui-layout.js`), so the
  orchestration in `app/tui.js` stays about keys, questions and the public surface.
- The mouse protocol is decided in `app/tui-screen.js`, which replaces blessed's
  `enableMouse`. **By default this program keeps the mouse**, so its own interactions work:
  the in-app selection, the wheel, the click-to-expand block and the click that removes a
  queued message all depend on the reports being sent. `NATIVE_SELECTION_ENABLED=1` hands the
  mouse to the terminal instead — no `?1000`/`?1002`/`?1003`/`?1006` is negotiated, so the
  terminal's own drag-to-select and copy work and every mouse interaction here stops
  (`docs/interface/clipboard-selection`). Keeping the mouse, this module asks for **?1006
  (SGR)** instead of blessed's own ?1005 (the UTF-8 extended X10 encoding), which X10 cannot
  use to carry a modifier on a release: its decoder does `b -= 32` and tests `b === 3`, so a
  modified release decodes as `mousedown` — and a gesture that finishes on `mouseup` would
  never finish, stranding the band. SGR puts the button, the modifiers and the edge in
  distinct fields.
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
  **markdown tables** (re-laid so their columns line up,
  `docs/interface/markdown-tables`), headings, lists, bold and inline code. It is
  pure (no screen needed) so it can be unit tested. Every discovery/read tool has a delimiter branch: `<file …>` (path +
  line range), `<grep …>` (pattern, path, match/file counts), `<blobs …>` / `<blob …>`
  (path, byte and line counts, `skipped` markers), and each carries its `truncated`
  flag into the header instead of printing the raw tag.
- A pasted block collapses into a single `[pasted N lines #id]` token and expands back
  **byte-for-byte**, so collapsing never alters the bytes the model receives. The token is
  one unit under the caret, and the block is caught before it becomes keystrokes
  (`docs/interface/paste-input`).
- The transcript is a model of plain lines and **collapsible blocks**: a tool
  result starts as one header line carrying its `X char response` size, and a click
  expands it (the next click collapses it) without touching the payload. The rules
  live in `docs/interface/transcript-blocks`.
- The user's own message is part of the transcript too, echoed as a `You:` header
  plus one quoted line per message line (`docs/interface/user-messages`). Both sides
  of the dialogue — that echo and the model's prose — are painted with a full-width
  background band, one colour each, with a one-line banded margin above and below
  (`docs/interface/prose-bands`).
- The status bar is one row with two slots: the logical status text (or the
  spinner frame) starts at the left edge and the **context meter is pinned to the
  right edge** — the token usage string plus the configured-vs-real label the
  window appends. `composeStatusRow()` lays the row out purely, and when the width
  is too small the left text is truncated, never the meter.
  The row directly above it carries the **working-time counter**, right-aligned
  through the same composer so the two end at the same column, and empty until the
  session has worked a second (`docs/context/working-time`). The pair is built
  together by `app/status-rows.js`, so a resize re-pins both at once.
- A compaction that fires while the request is in flight is announced in the
  transcript — the status bar is owned by the spinner at that moment — exactly once
  per event.
- The **kind** of each row is coloured too: the echoed prompt, tool calls and
  results, context notices and errors each get their own colour, while a line the
  markdown renderer already coloured is left as it is and prose keeps the terminal
  default. The palette and its rules live in `docs/interface/conversation-colors`.
  Each entry also carries the **local time it appeared**, at the head of its first
  display line (`docs/interface/conversation-timestamps`).
- `reload(chunks)` replaces the whole transcript with a stored conversation: the
  view is emptied and the session replayed into it as lines and collapsible blocks
  (`docs/interface/session-replay`), so opening a session shows it as it was left.
  Stamping is switched off for that replay: those rows appeared in a past run, so
  marking them with the reload time would state something false.
  A replay that carries the stored times marks each row with when it was written
  instead, behind a divider wherever the calendar day changes
  (`docs/interface/session-stamps`).

## The last-prompt hint (task-backlog)

> if the input box is empty, it should have a grayed italic text saying "Last
> prompt: ......."

The box is the one place on screen that is blank most of the time, and a returning
user cannot see what they asked a moment ago. `app/input-hint.js` fixes that:

- **empty only.** The hint is up exactly while the box holds no text. The first
  typed character replaces it with the text itself, and emptying the box brings it
  back. What decides is the box's own **value**, not a flag: the hint is never left
  over a box that has something in it.
- **content, never value.** The hint is written to the widget's *content*; the
  value stays empty. It can therefore never be submitted, queued
  (`docs/interface/message-queue`) or sent to the model, and the host loop's
  `question()` still resolves with what the user typed, or with nothing at all.
- **one flattened line.** The text is `Last prompt: <prompt>` (`LAST_PROMPT_LABEL`)
  with every run of whitespace collapsed to a single space — a multi-line prompt
  still fits the one row the box has — truncated to `HINT_MAX_CHARS` with an `…`,
  and sanitised first, so no control character can reach the widget. A prompt
  nothing was typed for (a blank submission, or the `exit` sentinel) leaves the
  previous hint in place: it is not a prompt.
- **greyed out.** The hint is painted in `HINT_COLOR` (`grey`) and the box's own
  colour is restored the moment it is replaced by real text.
  neo-blessed has **no italic attribute** — its tag vocabulary is
  bold/underline/blink/inverse/invisible (`program.js#_attr`) — so the "grayed
  italic" the backlog asked for ships as the greyed part. The deviation is stated
  here, not hidden.
- **one event, no second listener.** The box rewrites its content from `setValue()`
  whenever its value changes, and that emits `set content`, so the hint is repainted
  from that single event. A second `keypress` listener would make every keystroke
  arrive twice — exactly the bug the "armed by `question()` alone" rule above
  guards against.
- **the line CLI has no box hint.** It prints through `console.log` with readline
  as its editor, so there is no widget to paint over; `docs/interface/line-cli`
  states the difference.

## Status and feedback

- **Transient notices float over the top of the transcript.** A provider failure the
  retry loop recovered from is *news*, not history, so it is not written to the
  transcript: it is shown in a borderless box hanging one row under the brand line
  (`docs/interface/brand-line`) that hides itself after a few minutes, so the
  regions below never move and the reader's scroll position is untouched. The model,
  the expiry rules and the surface live in
  `docs/interface/notice-overlay`; `app/tui.js` only creates the overlay and hands
  it to the surface.

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

## Key bindings and the dispatch level

- Escape, Ctrl+C and **Tab** are answered on the **program**, ahead of the focused
  widget, and key dispatch is locked for that single event (`screen.lockKeys`,
  released in a microtask). Both would otherwise be lost: while the input box is
  reading, the textarea turns Escape into its own `cancel` event, and it appends
  every `ch` that is not a control byte — and the tab byte is *not* one of them, so
  a screen-level binding would both fire *and* type a tab into the prompt.
- Tab walks the intent modes (`docs/interface/modes`), Shift+Tab walks them the
  other way; the binding only reports the direction to its `onCycleMode` hook.
- The scrolling keys are bound on the **screen**, not the program, so a synthetic
  `screen.emit('keypress', …)` reaches them.

## See also

- Implementation: `app/tui.js` (screen wiring), `app/tui-layout.js` (regions),
  `app/tui-render.js` (pure text helpers), `app/tui-keys.js` (key bindings),
  `app/paste-registry.js` (the paste table, spec'd in `docs/interface/paste-input`),
  `app/compaction-notice.js` (the
  once-per-event compaction line), `app/status-row.js` (status/spinner/meter
  bookkeeping), `app/status-rows.js` and `app/work-row.js` (the meter and the
  working-time counter, built as one pair), `app/tui-transcript.js` (the transcript
  pane), `app/tui-surface.js` (the public surface),
  `app/tui-modal.js` (the picker modal and its `choose` surface),
  `app/prompt-input.js` (the armed-question / queueing box), `app/input-hint.js`
  (the last-prompt hint), `config/constants.js`
- Spec of the pending-message queue above the input box: `docs/interface/message-queue`
- Spec of the scroll position while output arrives: `docs/interface/transcript-scroll`
- Spec of the wheel and page steps: `docs/interface/transcript-smooth-scroll`
- Spec of the conversation palette: `docs/interface/conversation-colors`
- Spec of the reload when a session is resumed: `docs/interface/session-replay`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Spec of the working-time counter: `docs/context/working-time`
- Spec of the per-block timestamps: `docs/interface/conversation-timestamps`
- Proof: `tests/tui.test.js`, `tests/tui-render.test.js`, `tests/tui-status.test.js`,
  `tests/tui-modules.test.js`, `tests/input-hint.test.js`,
  `tests/transcript-blocks.test.js`, `tests/transcript-scroll.test.js`,
  `tests/transcript-smooth-scroll.test.js`, `tests/interrupt-controls.test.js`
