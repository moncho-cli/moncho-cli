# Runtime — conversation sessions on disk

A conversation is worth more than the process that produced it: the agent stores
the **full context** of every session as a dated file under `agent/sessions/`, so a
later run (or the `/sessions` command) can list the stored conversations and pick
one up again. This spec fixes the format and the store; the implementation is
linked below.

## Where sessions live

- The directory is `agent/sessions/` — inside the gitignored `agent/` tree, so
  sessions are disposable local state and never ship in a commit.
- One file per conversation, named after the date it started:
  `<ISO timestamp with ':' and '.' replaced by '-'>.json`
  (e.g. `2026-02-14T10-30-00-000Z.json`). The name is therefore unique, sortable
  and readable at a glance.
- `sessionPath()` refuses any id that could escape the directory (slashes, `..`,
  empty), so a session id can never become a path traversal.

## The file format

Versioned, pretty-printed JSON (one key per line, trailing newline) holding:

- `version` — the format version; a file with a different version is **refused**,
  never guessed at;
- `id`, `createdAt`, `updatedAt`, `model`, `cwd` — the metadata a picker shows;
- `counts` — chunk count and the count per role, so a listing can describe a
  session without loading it;
- `stats` — the context-window snapshot at save time (`usage`, …);
- `chunks` — **the full context, verbatim**: every message the `ContextWindow`
  holds, tool calls and tool results included.

`serializeSession()` copies the chunks defensively, and `parseSession()` validates
what was written, raising a coded `SessionStoreError` (`INVALID_JSON`,
`INVALID_SESSION`, `UNSUPPORTED_VERSION`, `NOT_FOUND`, `INVALID_ID`,
`INVALID_DATE`) so a caller can react instead of crashing.

## The store

- `writeSession()` writes through `writeFileVerified()`, so the file on disk is
  verified byte-for-byte before the write reports success.
- `listSessions()` returns light summaries, newest first (unreadable files are
  reported with their error code and sorted last, never dropped).
- `loadSession(id)` / `latestSession()` read one session back;
  `sessionChunks(session)` yields the chunks to replay into a window.
- `describeSession(summary)` renders the one-line label used by the picker.

## Recording the live conversation

`createSessionRecorder()` (`app/session-recorder.js`) owns the *current* session:
its id, start time and model. The host loop calls `save(chunks)` after every
completed turn and once more when the user exits, so the file always reflects the
live window — including after a compaction, because the snapshot is the window as
it stands. `saveIfUsed()` skips an untouched window, so a session that never
exchanged a message leaves no file behind.
- `adopt(id, { createdAt, model })` points the recorder at an **existing** session,
  which is what resuming does: the conversation continues in the file it came from
  instead of forking a parallel one, and it keeps the original start date
  (`docs/interface/session-replay`).

## See also

- Implementation: `utils/session-store.js`, `app/session-recorder.js`, `main.js`
- Spec of the reload after a resume: `docs/interface/session-replay`
- Proof: `tests/session-store.test.js`
