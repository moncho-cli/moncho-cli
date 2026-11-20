# Runtime — the uncompacted conversation log

`context.json` is the context that is **sent**: it is what the compaction rewrites, so
the stretch of work a summary paraphrases is gone from it. The verbatim record of a
conversation is worth keeping separately, which is what `conversation.json` is for
(task-backlog: "while preserving the context.json with the actual context that is sent,
also save a conversation.json that is the uncompacted version and has all the chunks all
the way back").

```
agent/sessions/<id>/context.json       the window that is sent   (compactable)
agent/sessions/<id>/conversation.json  every chunk, all the way back (append-only)
```

## The two files, side by side

| | `context.json` | `conversation.json` |
| --- | --- | --- |
| what it holds | the window the model is sent | every chunk, oldest first |
| a compaction | **rewrites** it (the older share → one summary) | never touches it |
| who writes it | `utils/session-store.js#writeSession` | `utils/conversation-log-store.js#writeConversationLog` |
| who reads it | `/sessions` resume, `sessionChunks()` | the resumed window's journal, a reader |
| shape | the session record | the log record (this spec) |

Both live in the session folder (`docs/runtime/session-store`), and both are written by
one save.

## The journal: how the history survives a compaction

The live history is **append-only state on the window**, not a copy made at save time:
`app/context-window.js#ContextWindow.journal` records every chunk `add()`/`addMany()` put
into the window, and nothing else ever appends to it. That single rule is what makes the
two files diverge exactly when they should:

- a **compaction** replaces the window's older share with one summary chunk and leaves the
  journal alone, so `context.json` shrinks and `conversation.json` does not;
- `stats().journalChunks` reports the history size against `stats().chunks`, the window
  size, so the pair is visible;
- `replace(chunks, { journal })` restores both when a session is resumed — the journal of
  a resumed conversation comes from its own log (`/sessions`), so a conversation compacted
  in a past run keeps the *whole* history in the log instead of restarting from the
  compacted window. With no journal given, the window is the best record available, so the
  journal restarts from exactly what is being restored;
- `clear()` is the one operation that empties both, because it means the conversation
  itself is gone.

## The file format

Versioned, pretty-printed JSON (one key per line, trailing newline) holding:

- `version` — the format version; a different one is **refused**, never guessed at;
- `kind: 'conversation-log'` — so a log accidentally pointed at as a session record is
  recognisable rather than parsed as one;
- `id` — the session the log belongs to (required: a log with no session cannot be
  attributed);
- `createdAt`, `updatedAt`, `model`, `cwd` — the metadata a reader shows;
- `counts` — chunk count and the count per role, so a listing can describe the log without
  loading the chunks (the same `countRoles()` the record uses);
- `chunks` — **every chunk ever said, verbatim**, oldest first.

Deliberately *smaller* than a session record: a log has no mode, no lock, no usage table
and no tracking content, because all of those are the live session's business and are
already stored in `context.json`. `serializeConversationLog()` copies the chunks
defensively (`{ ...chunk }`, exactly as `serializeSession()` does), so neither the live
window nor the record can be mutated through the other.

## Writing and reading

- **the write is ordered.** `createSessionRecorder().save()` writes `context.json` first
  and `conversation.json` after it (`app/session-recorder.js`), so a save that fails
  halfway leaves the window on disk and only the history one save behind. Never the
  reverse: a conversation that cannot be resumed is worse than a history a moment stale.
  The log is written through `writeFileVerified()`, like every other record, so success is
  reported only once the bytes on disk match.
- **reading is forgiving.** `readConversationLog()` answers `null` — never a throw — for
  both a missing file (a session written before the log existed) and an unreadable one (a
  half-written file, an unknown version). It is reached from the resume path, where the
  live record can still describe the conversation: a broken history must not be able to
  block a resume. `hasConversationLog()` answers whether the file is there at all, so a
  caller can tell "no log" from "an unusable log" if it ever needs to.
- **the log is host code, not a tool**, so no intent mode gates it: a `chat` session
  writes no file through a tool and still writes its own history
  (`docs/interface/modes`). "Read-only" is a claim about the project tree.

## See also

- Implementation: `utils/conversation-log.js` (the shape),
  `utils/conversation-log-store.js` (the paths, the write, the forgiving read),
  `app/context-window.js#ContextWindow.journal` (the append-only history),
  `app/session-recorder.js`, `app/commands.js`, `main.js`
- The record this file sits beside: `docs/runtime/session-store`
- What survives a compaction, and what does not: `docs/context/compaction`
- Proof: `tests/conversation-log.test.js`
