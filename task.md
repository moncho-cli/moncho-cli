status: done

# Resuming a session reloads the conversation as it was left

Picking up a stored conversation (`/sessions`, `docs/interface/commands`) today only
restores the **context window**: `sessionsCommand()` calls
`manager.contextWindow.replace(chunks)` and the host prints "Resumed <id> (N
chunk(s))." The conversation *view* is left empty, so the user continues talking to
a model that remembers everything while the transcript shows nothing. This task
closes that gap: opening a session must put the conversation back on screen exactly
as it was left, and continuing it must keep saving into the same session file.

## What "as it was left" means

The session file holds every chunk verbatim (`docs/runtime/session-store`), so the
replay is a *rendering* problem, not a storage one. Each chunk must reappear the
way the live loop rendered it in the first place
(`docs/runtime/startup-wiring`, `docs/interface/tui`):

| Chunk in the session | What the transcript shows on resume |
| -------------------- | ----------------------------------- |
| `user` | the `You:` echo + quoted lines (`docs/interface/user-messages`) |
| `assistant` with `tool_calls` | one `-> Calling <name>(<args>)` line plus its `intent:` line per call |
| `tool` | a collapsible block headed `[<tool> Output] (intent: …)` (`docs/interface/transcript-blocks`) |
| `assistant` with `content` | the assistant prose |
| `system` + `compacted: true` | a `[Context]` notice that this part was summarised |

Replay is **presentation only**: nothing is re-sent to the model, the restored
chunks stay byte-identical, and a resumed transcript never gains a chunk. The live
loop and the replay must share one formatting path, otherwise the two drift and a
resumed conversation looks different from the one that produced it.

## Constraints

- One formatting path: the `-> Calling …` / `intent:` / `[<tool> Output]` shapes are
  built by one shared helper used by both `ConversationManager` and the replay.
- A tool chunk records only `tool_call_id` and its content, so the tool **name** is
  recovered by matching the id against the preceding assistant `tool_calls`; an
  unmatched chunk must still render, never throw.
- Continuing a resumed conversation saves back into **the same** session file, so
  the id is adopted by the recorder rather than a new file being started.
- Replay must work in both front ends: collapsible blocks in the TUI, plain lines in
  the line CLI (which never renders blessed tags).
- Every file stays under the 300-line budget; extract rather than grow.

- [x] **reload the conversation view when a session is resumed** — resuming restored the *context window* only, so the model remembered everything while the transcript stayed empty. `app/session-replay.js` rebuilds the display from the stored chunks: the `You:` echo, one `-> Calling …` + `intent:` line per call, a collapsible block per tool result (its tool name recovered by matching `tool_call_id` against the assistant chunk), the reply inside its delimiters, and a `[Context]` notice for a summarised chunk. `renderReplay()` drives either front end and `reloadConversation()` empties the view first; the TUI's `reload()` also resets the compaction notifier. `app/tool-call-format.js` builds every one of those shapes for **both** the live loop and the replay, so a reloaded conversation cannot drift from the one that produced it. The host reloads after `RESUMED` and the recorder `adopt()`s the resumed id, so the conversation keeps saving into the file it came from. Proven by `docs/interface/session-replay` and `tests/session-replay.test.js` (9 cases).

## Done when

- the spec exists, is registered, and names real `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines.
