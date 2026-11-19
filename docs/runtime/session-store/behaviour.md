# Runtime — conversation sessions on disk

A conversation is worth more than the process that produced it: the agent stores the
**full context** of every session on disk, so a later run (or the `/sessions` command)
can list the stored conversations and pick one up again. This spec fixes the layout,
the format and the store; the implementation is linked below.

## Where sessions live

- The directory is `agent/sessions/` — inside the gitignored `agent/` tree, so
  sessions are disposable local state and never ship in a commit.
- **One folder per conversation**, named after the date it started:
  `agent/sessions/<ISO timestamp with ':' and '.' replaced by '-'>/`
  (e.g. `2026-02-14T10-30-00-000Z/`). The name is therefore unique, sortable and
  readable at a glance.
- The conversation itself is **`context.json`** inside that folder, next to the two
  tracking files the same conversation owns:

  ```
  agent/sessions/<id>/context.json            the conversation (this spec)
  agent/sessions/<id>/task.md                 its checklist (docs/agent/task-tracking)
  agent/sessions/<id>/implementation_plan.md  its plan      (docs/agent/task-tracking)
  ```

  Everything belonging to one conversation sits together, and a resumed session keeps
  updating the same three files. Before the folder existed the conversation was the
  flat file `agent/sessions/<id>.json` — *beside* a folder of the same name, which is
  why the record disappeared as soon as the folder was created. There is now one path
  per session and one meaning per path.
- `sessionDir()` and `sessionPath()` (`…/<id>/context.json`) share one validation
  rule: an id containing a slash, a backslash, `..` or nothing at all is refused with
  `INVALID_ID`, so neither a folder nor a record can ever become a path traversal.
- `legacySessionPath()` names where the old layout kept the record, so the migration
  is one explicit rule instead of a special case buried in the readers.

## Reading a session stored by the older layout

The two layouts coexist without a migration step the user has to run:

| Situation | `listSessions()` | `loadSession()` |
| --------- | ---------------- | --------------- |
| only `<id>/context.json` exists | the folder record, `layout: 'folder'` | the folder record |
| only `<id>.json` exists (old tree) | the flat record, `layout: 'flat'` | the flat record — the conversation still resumes |
| both exist for one id | **one** row, the folder one | the folder record (the live one) |

Writing converges the tree on `writeSession()`: the record lands in the folder and the
now-stale flat file of the same id is removed, so a conversation never ends up with two
records that can disagree. Removing that file is housekeeping — it can never fail a
good save. `migrateSession(id)` is the explicit form for a caller that wants the whole
tree on the current layout at once; it re-lays-out the bytes it read, never
re-serialising from a guess, and answers `false` when there is nothing to move.

## The file format

Versioned, pretty-printed JSON (one key per line, trailing newline) holding:

- `version` — the format version; a file with a different version is **refused**,
  never guessed at;
- `id`, `createdAt`, `updatedAt`, `model`, `cwd` — the metadata a picker shows;
- `mode`, `work` — the session's intent mode and its execution lock
  (`docs/interface/modes`). Both are **optional**: a file written before they existed
  carries no mode and still loads, and the session keeps the state it opened with.
- `counts` — chunk count and the count per role, so a listing can describe a
  session without loading it;
- `stats` — the context-window snapshot at save time (`usage`, …);
- `usage` — the per-model token table (`docs/context/model-usage`); it is
  **optional**, so a file written before it existed loads with an empty table;
  the working time the session added up rides the same table (`thinkingMs`,
  `toolMs`), so `/usage` and a resumed session report how long the agent worked
  (`docs/context/working-time`);
- `chunks` — **the full context, verbatim**: every message the `ContextWindow`
  holds, tool calls and tool results included.

`serializeSession()` copies the chunks defensively, and `parseSession()` validates
what was written, raising a coded `SessionStoreError` (`INVALID_JSON`,
`INVALID_SESSION`, `UNSUPPORTED_VERSION`, `NOT_FOUND`, `INVALID_ID`,
`INVALID_DATE`) so a caller can react instead of crashing.

## The store

- `writeSession()` writes through `writeFileVerified()`, so the record on disk is
  verified byte-for-byte before the write reports success.
- `listSessions()` returns light summaries, newest first (unreadable records are
  reported with their error code and sorted last, never dropped), and a folder without
  a `context.json` is simply not a session.
- `loadSession(id)` / `latestSession()` read one record back;
  `sessionChunks(session)` yields the chunks to replay into a window.
- `describeSession(summary)` renders the one-line label used by the picker.

## Recording the live conversation

`createSessionRecorder()` (`app/session-recorder.js`) owns the *current* session:
its id, start time and model. The host loop calls `save(chunks)` after every
completed turn and once more when the user exits — and, mid-turn, whenever the
conversation itself changes — so the record always reflects the
live window — including after a compaction, because the snapshot is the window as
it stands. `saveIfUsed()` skips an untouched window, so a session that never
exchanged a message leaves no folder behind. `save(chunks, { stats, usage })` also
stores the per-model token table, so what the conversation cost is part of the
record (`docs/context/model-usage`).
- **The record follows the conversation, not the turn.** `save()` is called at the
  moments the conversation changes, not only when a turn ends
  (`app/session-autosave.js`). The rule is a *leading-edge throttle*: the first
  change — the user's own message — is written immediately, so the session exists on
  disk from the first thing said; a burst of chunks inside the next half-second (one
  tool batch adds an assistant chunk plus one chunk per call in the same tick) is
  coalesced into a single trailing write, because a record is hundreds of kilobytes
  written under byte-for-byte verification and a write per chunk would cost more than
  it buys. The throttle is host state and a `setTimeout` that is `unref`'d, so a
  pending write never holds the process open. `settle()` drops the queued write after
  a save that already holds the whole window (the loop's own turn and exit saves), and
  `close()` stops the throttle for good. A write that throws is contained and reported
  through `lastError`: the record is important, the conversation more so.
- This save is **host code, not a tool**, so no intent mode gates it: a `chat`
  session writes no file through a tool but still writes its own session record
  (`docs/interface/modes`). "Read-only" is a claim about the project tree.
- `adopt(id, { createdAt, model })` points the recorder at an **existing** session,
  which is what resuming does: the conversation continues in the folder it came from
  instead of forking a parallel one, and it keeps the original start date
  (`docs/interface/session-replay`).

## See also

- Implementation: `utils/session-store.js` (the layout, the scan, the migration),
  `utils/session-format.js` (the record shape), `app/session-recorder.js`, `main.js`
- The folder the tracking files share: `docs/agent/task-tracking`
- Spec of the reload after a resume: `docs/interface/session-replay`
- Proof: `tests/session-store.test.js`, `tests/session-layout.test.js`,
  `tests/session-autosave.test.js`