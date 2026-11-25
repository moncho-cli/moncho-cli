# Interface — the pending-message queue

A turn can take minutes — tool chains, long provider calls — and the input box was
only *armed* between turns, so a message typed during a turn went nowhere: the
user either lost what they typed or waited, idle, for the reply before typing the
follow-up they already knew they wanted.

The queue fixes that (task-backlog: "able to send messages at any moment that are
queued … and injected when possible … with an X that you can delete them from the
queue"). This spec fixes the five rules the behaviour is made of; the
implementation is linked below.

## accept

While a request is in flight the input box **stays armed**: `startSpinner()` is the
moment the in-flight state begins and it arms the box, so Enter reaches the box
exactly as it does between turns. A submission with **no armed question** — the
whole of `processInput()` — is **queued** instead of resolving a question nobody
armed. A submission *with* an armed question is the idle case and settles it
exactly as before, so nothing about the existing prompt flow changes.

Enter ends neo-blessed's read cycle, so the box is armed again right after a queued
submission: without that, the second message of a long turn would be the last one
that landed. The re-arm is **one** read cycle — a keystroke must append one
character, never two.

## keep

The queue is **FIFO** and the text is kept **verbatim**: no trimming, no
whitespace collapsing, newlines included. A long paste goes through the paste
table like any other submission, so the `[[paste:<id>]]` tag that reaches the box
is expanded back before the message is stored — the bytes the model receives are
the bytes the user typed. An empty or blank message is **not** queued: there is
nothing to inject.

## show

The rows sit **right above the input box**, in a region of their own
(`app/tui-layout.js#setQueueHeight`): the status bar, the model row and the
transcript shift up by the queue height while the input box never moves, and the
region is hidden at height 0, so an empty queue costs no row. Every row is
`✕ <position>. <preview>`, one per message in queue order, with the preview
flattened to a single line and truncated; more messages than the bar paints
collapse into a `+N more` tail naming how many are not shown. The widget is a view
of the model: every mutation repaints it, so the rows can never disagree with the
queue.

### the row is fitted to the width it really has

A row measures what it is drawn in, so the preview stays readable (task-backlog:
"the messages in queue get strangely truncated, too soon, i cant read whats there").
The bar passes its interior width down as a number of **cells**, and
`queuePreviewBudget` takes the `✕ <position>. ` prefix off that budget — the marker
and the position stay readable whatever happens — and gives the rest to the preview.
The counting is in cells, not characters (`displayWidth`, `truncateToWidth`): a wide
glyph costs two cells and a combining mark none, so a row holding them still fits.

A row therefore always ends up **one display line**, which is the point: the region's
height is the number of rows *painted*, so a row that wrapped onto a second display
line was clipped by the widget and its tail vanished with no `…` at all. A resize
re-fits every row, because the width changed with the window. A caller with **no
width** — the line CLI, which has no bar, or the first paint before the widget is
laid out — keeps the historical fixed `QUEUE_PREVIEW_CHARS` cap rather than
inventing one.

## delete

A click on a row removes **that message only** and the region shrinks back; the
click geometry (`queueRowAt`) maps the screen row through the widget's border and
padding and through blessed's fake→real table, so a preview that happens to wrap
still deletes the message it belongs to. Since a row is fitted to the bar it never
wraps, so that mapping is a safety net rather than the common path. A click outside
the painted messages — on the border, above the region or on the `+N more` tail —
deletes nothing.

## inject

The host loop drains the queue **between two turns** — "when possible" — through
`nextPrompt()`: the queue is emptied and **every** waiting message becomes the next
prompt, and only when the queue is empty is the front end's own question asked.
Draining there, and never inside a tool chain, is what keeps an assistant
`tool_calls` message together with its `tool` results: an injected batch can never
split them.

### the whole queue is one prompt

A user who queues three notes in the same minute meant them as **one instruction**
(task-backlog: "if the user sends more than one message that get queued, all messages
would have to be included at the same time, not 1 message then work then other
message"). Handing them over one turn at a time would answer the first note before the
second was even read — a whole turn spent on the wrong task — so `drainAll()` empties
the queue at once and `joinQueued()` is the one place that says how several messages
become one: the texts **in order, verbatim**, separated by a blank line. Nothing is
added — no preamble, no numbering — because a preamble would be the harness talking to
the model inside the user's own message. A queue of **one** is returned byte-for-byte,
so the ordinary single-message case is exactly what it was before batching existed.

`nextPrompt()` prefers `drainAll()` and falls back to a single `dequeue()` for a front
end that has only that, so a queue of one crosses both paths identically.

The drained text enters the conversation as the **ordinary user prompt** — the
queue is a buffer in front of `question()`, not a chunk of its own — so
`docs/interface/user-messages` and the context window see exactly what they would
have seen had the user typed it a moment later.

## The line CLI

The line CLI has no queue bar: typed input is buffered by readline and arrives at
the next `question()`. `nextPrompt()` receives no `dequeue` there, so the front end
is the only source of prompts. The difference is stated, not hidden.

## See also

- Implementation: `app/message-queue.js` (the model, the click geometry and the
  injection rule), `app/queue-rows.js` (how a message is drawn: the cell counting
  and the width budget), `app/queue-bar.js` (the widget binding),
  `app/prompt-input.js` (the armed-question / queueing box),
  `app/tui-layout.js#setQueueHeight` (the region), `app/tui.js#createTui`, `main.js`
- Spec of the surrounding screen: `docs/interface/tui`
- Spec of the prompt as the model receives it: `docs/interface/user-messages`
- Spec of the loop that drains it: `docs/runtime/startup-wiring`
- Proof: `tests/message-queue.test.js`, `tests/queue-rows.test.js`,
  `tests/message-queue-tui.test.js`, `tests/tui.test.js`
