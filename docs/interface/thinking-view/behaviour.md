# Interface — the `Thinking` label as a door onto the reasoning stream

> Original item (backlog 37): *use the stream mode when calling the model api, if the
> user clicks on the Thinking label, show a modal that fills most of the screen (but not
> all) that shows the current thinking stream*

The streaming half already shipped: `api/stream-reader.js` reads a response incrementally
and `api/ollama.js` appends every reasoning delta to `THINKING_FILE`
(`config/constants.js`, `agent/thinking.md` by default, cleared at the start of each
stream). What was missing is the second half — a way to **read that stream from the
screen**. This spec is that half, and it adds no capture of its own: the file is the
stream, and this is the door onto it.

## The label, while it is there

The status bar's left slot carries `Thinking ⠿` while a request is in flight
(`app/status-row.js`), and the logical status text between turns. The label is a target
**only in the first state**: a click between turns does nothing at all, because the text
there is not an invitation.

The row is composed by `composeStatusRow`, which right-aligns the meter and truncates the
left slot when the two do not fit — between grapheme clusters, never inside one. So the
hit zone is **measured, not guessed**: `thinkingHitZone()` (`app/thinking-view.js`) repeats
the composer's arithmetic against the same two strings and the same width, and answers the
half-open interval of cells the label really occupies. A zone derived from the label's own
width would be wrong on exactly the narrow terminal where the label is truncated.

The interval is relative to the box; the event's column is absolute, measured from the
screen's left edge — that is how blessed reports it, and how the queue bar already reads
it (`app/queue-bar.js#clickAt`). `clickedThinkingLabel()` adds the box's own origin
(`statusBar.lpos.xi`) back, so a box that is not at column 0 still measures its own cells.
An event with no usable coordinate is **not** a hit: a label that opens a box on a guess
is worse than one that misses.

## The view

The click opens the **same read-only viewer `/task` uses**
(`app/content-modal.js#openContentModal`, reached through the surface's own `contentView`),
so the geometry, the selection and copy, the keyboard lease and the live refresh are not
re-implemented. That is the whole reason this module holds no blessed import.

The documents come from `readThinkingCapture()`, which is **forgiving by construction**:
a missing file (a session that has not streamed yet) and an unreadable one (a half-written
capture) both answer `null` rather than throwing, and a path outside the project is
refused by the same sandbox every file tool uses. An **empty** capture is not a document —
`thinkingDocuments()` drops it, so `openContentModal` answers `null` for the empty list and
a click a moment before the first delta opens nothing rather than an empty box that would
have to be dismissed.

The `reload()` is the point of the view rather than a detail: the stream is written
*while* the box is open, so a snapshot would show reasoning the reader has already
finished thinking about.

## The capture exists in production, which took a second pass

The first version of this feature read `THINKING_FILE` and assumed the file was already
there "whenever a streaming call ran". **No production call site streams.**
`app/conversation-manager.js`, `app/compaction-runner.js` and `main.js` all pass
`isStreaming = false`, because `api/stream-reader.js#readStream` assembles content and not
`tool_calls` — so a streaming request cannot answer a tool batch. The only branch that
appended to the capture was therefore dead in production, the file was never created, and
every click was consumed opening nothing: the wiring was right and the feature was empty.

So the capture has **two producers**, and both write the same file:

- **the streaming branch** appends each reasoning delta as it arrives
  (`api/ollama.js#callOllama`);
- **the non-streaming branch**, which is the one production takes, writes the reasoning
  the provider returned in the same reply (`captureThinking`), so the view has a capture
  whether or not the call streamed.

The reasoning has to survive normalisation to reach it: `normalizeResponse` used to drop
`message.thinking` on the Ollama shape, and now keeps it — leaving the field out
altogether when the provider sent none, so a reply without a reasoning channel is shaped
exactly as it was before. `captureThinking` writes nothing for an absent or empty
reasoning rather than truncating the last real capture for nothing, and never throws: a
capture is a view, and losing one must not cost the reply.

The non-streaming capture is a **snapshot of the call that just finished**, not a stream
that grows: that reasoning is only complete when the reply lands, which is *after* the
spinner stops. The `reload()` still earns its place — a streaming call writes while the
box is open — but on the non-streaming path the box shows the completed reasoning, which
is what a reader who clicked while the spinner was up wants to read once it lands.

## The wiring

`bindThinkingClick()` is the seam, called from `app/tui.js` with the status bar, the row's
model and the surface. Three rules keep a click from being a nuisance:

- **nothing happens between turns** — the zone is read only while `isSpinning()` is true;
- **only a hit is consumed** — every other click on the row falls through, so the status
  bar behaves exactly as it did before;
- **a failing open is reported, never thrown** — a click is a keystroke-like event, so a
  modal that throws reports through the notice overlay instead of into the event loop.

The status bar is made `clickable: true, autoFocus: false` in `app/tui-layout.js`: the
first flag is what makes blessed hit-test the row at all (a plain box is never delivered a
mouse event), and the second keeps a click from pulling the keyboard away from the input
box, which is the single arming point for typing. The binding is disposed at teardown.

## What it does not do

- **It never touches the request.** No chunk, no session file, no provider call: the
  capture is the provider's own output and the box is a view of it.
- **It does not require the switch.** Unlike the item collapse and the chunkpaction
  (`docs/context/item-collapse`), nothing here is gated: a call that returns reasoning
  writes the capture whether or not it streamed, and reading a file costs no context.
- **It does not show the conversation's summary.** It shows the raw reasoning file, which
  is what the backlog entry asked for and what the reader can check against the replay.

## See also

- Implementation: `app/thinking-view.js` (the pure half), `app/status-row.js#leftText`,
  `app/tui-layout.js` (the clickable row), `app/tui.js` (the wiring),
  `app/content-modal.js` (the viewer it reuses)
- Where the capture is written: `api/ollama.js#captureThinking` (the non-streaming
    path) and `api/ollama.js#callOllama` (the streaming one),
    `api/provider-response.js#normalizeResponse`, `config/constants.js#THINKING_FILE`
- The viewer it reuses: `docs/interface/task-viewer`
- Proof: `tests/thinking-view.test.js`