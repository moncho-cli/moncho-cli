# Runtime — startup wiring and the conversation loop

`main.js` wires the realms together: it picks the front end, loads the tools,
resolves the context size, and runs the conversation loop that turns one user
message into model calls and tool executions. This spec fixes that wiring and the
loop's observability guarantees; the implementation is linked below.

## Startup order

1. Read the model identity from the environment (`describeModel()`).
2. Resolve the context size (config override → provider → default) *before* the
   window exists, so the budget is fixed for the whole session.
3. Build the front end: `createTui()` when stdout is a TTY, otherwise
   `createCLI()`. The interrupt hook is late-bound to the `AbortManager` created
   afterwards, and a TTY means the manager must not install its own stdin listener
   (`captureKeys: false`) — see `docs/interface/interrupt-controls`.
4. Load the tools with a result hook that echoes each result (and its intent) to
   the screen.
5. Create the `ConversationManager` with the resolved budget, the provider/model
   label and an `onContextChange` hook that paints the token meter.

## The conversation loop

- One user input is appended as a `user` chunk, then the loop repeats until a
  final (tool-free) assistant message arrives or an error/abort ends the task.
- **Before every model call** the window is checked against the budget and
  compacted when needed, so the model is never called with an over-budget window.
- A `null`/empty response is treated as transient: it is reported and retried
  rather than ending the task.
- When the model asks for tools, a single assistant chunk carrying **all** tool
  calls is stored (OpenAI-compatible), then each call is executed and recorded as a
  `tool` chunk. The call's `intent` is printed **and** stored at the head of the
  result chunk, so the reason for a call is both visible and part of the model
  context.
- Tool failures are captured, not thrown: the error text becomes the tool chunk
  (marked `[error]`), so the model can react instead of the loop dying.
- A `compact_context` result that requests a real compaction is detected by the
  loop, which then forces the compaction because it owns the provider connection.

## Cancellation

- The loop reads the active `AbortSignal` from the `AbortManager` before each
  model call and passes it down. An abort ends the task quietly (an informational
  line, no stack trace), and the host loop then clears the task and stops the
  spinner in a `finally` block.
- A failed compaction never breaks the task: the loop reports the skip and
  continues with the unchanged window.

## Observability

- Tool calls print as `-> Calling <name>(<args>)` plus an `intent:` line; args are
  formatted compactly (long strings become `string(N chars)`).
- The final reply is printed in a delimited block followed by the context usage, so
  every turn ends with the window's token position.
- The status bar / transcript receive every context change and compaction notice
  through `onContextChange`, keeping the UI a view of real state rather than a
  second source of truth.

## See also

- Implementation: `main.js`, `app/conversation-manager.js`, `app/context-window.js`,
  `app/abort-manager.js`, `utils/tool-loader.js`
- Proof: `tests/conversation-manager.test.js`
