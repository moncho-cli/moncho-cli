# Interface — reloading a stored conversation

Opening a session used to restore the **context window** and nothing else:
`sessionsCommand()` replaced the chunks, the host printed "Resumed \<id\> (N
chunk(s)).", and the transcript stayed empty. The model remembered the
conversation while the screen showed nothing, so the user had no idea what they
were continuing. This spec fixes the replay that closes that gap; the
implementation is linked below.

## What is reloaded

The session file holds every chunk verbatim (`docs/runtime/session-store`), so
reloading is a *rendering* problem. `replayChunks(chunks)` turns the stored
chunks back into the display the live loop produced for them
(`docs/runtime/startup-wiring`), as a list of render operations
(`{ kind: 'log' | 'block', … }`) rather than printed lines:

| Chunk | What comes back on screen |
| ----- | ------------------------- |
| `user` | the `You:` echo and its quoted lines (`docs/interface/user-messages`) |
| `assistant` with `tool_calls` | one `-> Calling <name>(<args>)` line plus its `intent:` line per call |
| `tool` | a collapsible block headed `[<tool> Output] (intent: …)` (`docs/interface/transcript-blocks`) |
| `assistant` with prose | the reply, bracketed by the `--- AI Response ---` delimiters the loop prints |
| `system` + `compacted: true` | a `[Context]` notice that earlier context was summarised |

- The **tool name is not stored** in a tool chunk (only the `tool_call_id` and the
  body), so it is recovered by matching the id against the preceding assistant
  `tool_calls`. A chunk with no recorded call still renders, under a generic
  `[tool Output]` name, rather than throwing.
- An assistant chunk that carries prose *and* tool calls prints the prose, then
  each call next to the result it answers. An empty assistant turn, an unknown
  role and a `null` entry are skipped instead of crashing the replay.
- A tool result that failed keeps its `[error]` marker out of the body: the block
  shows the error text, the intent stays in the header.

## One formatting path

The replay never re-implements a shape. The `-> Calling …` line, the `intent:`
line, the `[<tool> Output]` header and the body of a `tool` chunk are all built by
`app/tool-call-format.js`, which the live `ConversationManager` uses too. That is
what stops a reloaded conversation from looking different from the one that
produced it — and the module is the *inverse* pair of
`formatToolResultChunk()`/`parseToolChunk()`, so a chunk written by the loop is
unwrapped by the replay.

## Driving a front end

`renderReplay(ops, { log, logBlock })` renders the operations:

- with `logBlock` (the TUI) a restored result is a real collapsible block, so it
  can still be clicked open and shut;
- without it (the line CLI has no widget) a block prints as its header, its body
  and a blank line — the very shape `main.js` uses for a live tool result there.

`reloadConversation(chunks, { log, logBlock, clear })` does both steps: it empties
the view first (so the previous conversation is replaced, not appended to) and
then replays. The TUI's `reload()` goes through it and also resets the compaction
notifier, because a compaction already announced is no longer on screen.

## Continuing the conversation

Resuming must *continue* the session that was opened, so the host adopts its
identity: `createSessionRecorder().adopt(id, { createdAt, model })` points the
recorder at the existing file and keeps the conversation's original start date.
Without it every resume would fork a parallel file and the one the user picked
would stop being updated.

## Presentation only

Replay touches neither the chunks nor the model: the restored window is byte-for-byte
the one in the session file, nothing is re-sent to the provider, and the reload
happens *after* the window has been replaced. The per-turn `[Context] <usage>`
line of the live transcript is not reproduced — it reported the window as it stood
at that moment, which the status-bar meter already shows.

## See also

- Implementation: `app/session-replay.js`, `app/tool-call-format.js`,
  `app/commands.js`, `app/session-recorder.js`, `app/tui.js`, `main.js`
- Spec of the stored sessions: `docs/runtime/session-store`
- Spec of the commands: `docs/interface/commands`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Spec of the echoed prompt: `docs/interface/user-messages`
- Proof: `tests/session-replay.test.js`
