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
(`{ kind: 'log' | 'prose' | 'block', … }`) rather than printed lines:

| Chunk | What comes back on screen |
| ----- | ------------------------- |
| `user` | the `You:` echo and its quoted lines, as a **`prose`** op (`docs/interface/user-messages`) |
| `assistant` with `tool_calls` | one `-> Calling <name>(<args>)` line plus its `intent:` line per call; prose next to the calls is a **`prose`** op |
| `tool` | a collapsible block headed `[<tool> Output] (intent: …)` (`docs/interface/transcript-blocks`) |
| `assistant` with prose | the reply as a **`prose`** op, bracketed by the `--- AI Response ---` delimiters the loop prints |
| `system` + `compacted: true` | a `[Context]` notice that earlier context was summarised |

A `prose` op names the *side of the dialogue* (`role: 'user' | 'assistant'`), so a
front end that bands can paint it (docs/interface/prose-bands) and the line CLI, which
has no band, prints it as the plain line it always was.

- A compaction leaves a real `user` chunk in the window when it carries the user's
  last message verbatim (`docs/context/compaction`), and that chunk replays like any
  other: the reloaded transcript shows the `You:` echo again, in the place the
  window holds it.

- The **tool name is not stored** in a tool chunk (only the `tool_call_id` and the
  body), so it is recovered by matching the id against the preceding assistant
  `tool_calls`. A chunk with no recorded call still renders, under a generic
  `[tool Output]` name, rather than throwing.
- An assistant chunk that carries prose *and* tool calls prints the prose, then
  each call next to the result it answers. An empty assistant turn, an unknown
  role and a `null` entry are skipped instead of crashing the replay.
- A tool result that failed keeps its `[error]` marker out of the body: the block
  shows the error text, the intent stays in the header.
- A result stored by a **batch** arrives inside the `<tool-multicall result>`
  envelope (`docs/agent/tool-multicall`); `parseToolChunk()` unwraps it, so the
  block shows the tool's own output and the signature never reaches the
  transcript.

## One formatting path

The replay never re-implements a shape. The `-> Calling …` line, the `intent:`
line, the `[<tool> Output]` header and the body of a `tool` chunk are all built by
`app/tool-call-format.js`, which the live `ConversationManager` uses too. That is
what stops a reloaded conversation from looking different from the one that
produced it — and the module is the *inverse* pair of
`formatToolResultChunk()`/`parseToolChunk()`, so a chunk written by the loop is
unwrapped by the replay.

## Driving a front end

`renderReplay(ops, { log, logProse, logBlock })` renders the operations:

- with `logBlock` (the TUI) a restored result is a real collapsible block, so it
  can still be clicked open and shut;
- with `logProse` a `prose` op is printed through the band route
  (docs/interface/prose-bands), so a resumed conversation shows its two sides banded
  exactly as the live one did;
- without either (the line CLI has no widget and no band) a block prints as its
  header, its body and a blank line — the very shape `main.js` uses for a live tool
  result there — and a prose op prints as a plain line.

`reloadConversation(chunks, { log, logProse, logBlock, clear })` does both steps: it empties
the view first (so the previous conversation is replaced, not appended to) and
then replays. The TUI's `reload()` goes through it, hands it the same `logProse` the
live loop uses, and also resets the compaction notifier, because a compaction already
announced is no longer on screen.

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

## When each block was written

The chunks carry no times of their own, so the record keeps them beside the chunks and
`replayChunks(chunks, { stamps })` hands each one to the op it produced. A front end
that marks its entries (the TUI) paints the stored time instead of the clock, and a day
divider opens each calendar day the conversation spans; the line CLI prints the text
alone, so it is unchanged. A record without times replays to exactly the elements it
always did. The rules are `docs/interface/session-stamps`.

## See also

- Implementation: `app/session-replay.js`, `app/tool-call-format.js`,
  `app/commands.js`, `app/session-recorder.js`, `app/tui.js`, `main.js`
- Spec of the stored sessions: `docs/runtime/session-store`
- Spec of the commands: `docs/interface/commands`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Spec of the echoed prompt: `docs/interface/user-messages`
- The times each block shows: `docs/interface/session-stamps`
- Proof: `tests/session-replay.test.js`
