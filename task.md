status: done

# Message queue: send at any moment, keep the queue above the input box, delete with ✕

Taken from `task-backlog.md`:

> able to send messages at any moment that are queued (kept right above the input
> box) and injected when possible in the conversation. but while queued have an X
> that you can delete them from the queue

A turn can take minutes — tool chains, long provider calls — and the input box is
*disarmed* while it runs: `question()` is only armed between turns, so a message
typed during a turn goes nowhere. The user either loses what they typed or waits,
idle, for the reply before typing the follow-up they already know they want.

The fix is a queue: typing during a turn stores the message, keeps it visible right
above the input box with a `✕` that deletes it, and the host loop injects it as the
next prompt as soon as the running turn finishes.

## What the queue must do

| Step | Behaviour |
| ---- | --------- |
| accept | while a request is in flight the input box stays armed; Enter **queues** the message instead of resolving a question nobody armed |
| keep | the queue is FIFO and the text is kept **verbatim** (pastes expanded), so the bytes the model receives are the bytes the user typed |
| show | the rows sit **right above the input box**; the status bar, model row and transcript shift up by the queue height, and the queue disappears when it is empty |
| delete | every row carries a `✕`; a click on the row removes that message only, and the region shrinks back |
| inject | the host loop drains the queue **between turns** — "when possible" — so a queued message becomes the next prompt without waiting for the user |
| survive | a message queued while idle is not queued at all: the box resolves the armed question exactly as it does today |

## Constraints

- The queue model (`app/message-queue.js`) is **pure** — no neo-blessed, no screen —
  so the order, the deletion and the row formatting are unit tested without a pty.
- The widget binding lives in `app/queue-bar.js`, bound by `app/tui.js`, so the
  screen wiring stays thin and every file stays under 300 lines.
- Injection happens **between two turns**, never in the middle of a tool chain: an
  injected message must not split an assistant `tool_calls` message from its `tool`
  results.
- The line CLI has no queue bar; typed input there is buffered by readline and
  arrives at the next `question()`. That difference is stated, not hidden.
- The queue never reaches the model context as a chunk of its own: the drained text
  enters the conversation as the ordinary user prompt (`docs/interface/user-messages`).

## Steps

- [x] **the queue model and its rows** — `app/message-queue.js` gains `createMessageQueue()` (enqueue / dequeue / remove / clear / subscribe, verbatim text, FIFO), `nextPrompt()` (the between-turns drain rule), `formatQueueRows()`/`formatQueueRow()`/`previewMessage()` (one `✕` row per message, capped with a `+N more` tail) and `queueRowAt()` (the click geometry), proven by `tests/message-queue.test.js`.
- [x] **the queue bar in the TUI, and the injection point** — `app/queue-bar.js` renders the rows in the new region right above the input box (`app/tui-layout.js#setQueueHeight`), deletes on a `✕` click, and `app/prompt-input.js` queues a submission while a request is in flight and re-arms the box; `app/tui.js` opens that in-flight state with the spinner and exposes `dequeue()`/`queuedCount`; `main.js` drains the queue between turns through `nextPrompt()`. Proven by `tests/message-queue-tui.test.js` and `tests/tui.test.js`.
- [x] **document and prove the message queue** — a `docs/interface/message-queue` spec (registered in `docs/index.yaml`) states the accept/keep/show/delete/inject rules; `interface/tui`, `interface/line-cli` and `runtime/startup-wiring` are updated; the tests above are linked by their exact case names.

## Done when

- the spec exists, is registered, and names real `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines;
- a scratch probe under `agent/utils/` confirmed the row geometry and the click
  mapping before the tests were written, and is deleted afterwards.
