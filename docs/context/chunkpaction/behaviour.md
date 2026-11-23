# Context — the chunkpaction capture

A collapse (`docs/context/item-collapse`) replaces a solved item's whole section — its
reasoning, its tool calls, its results — with one deterministic summary. The summary says
the detail is still available. **That claim has to be followable**, and until this
capability existed it was not: the summary pointed at the conversation journal, which is a
file on disk and which no tool reads.

This is the file and the reader that make the pointer real, and it is the same shape the
harness already uses for a long command output — a handle the model can ask for — with one
difference that is the whole point:

| | `read_capture` | `read_chunkpaction` |
| --- | --- | --- |
| what it holds | a command's output that was truncated | the raw chunks a collapsed section replaced |
| where it lives | in memory (`utils/capture-store.js`) | the session folder (`chunkpaction.json`) |
| how long | expires at the next batch that does not read one | for the life of the session, across a resume |
| how it is named | a `capture: <id>` handle in the command document | a capture id in the collapsed summary |

A command capture is short-lived on purpose: command output is attacker-influenced text
and nothing should be able to execute it later. A chunkpaction is the conversation's own
record, so it is durable — a summary written ten turns ago must still resolve after a
restart.

## The file

`chunkpaction.json` sits beside the other two in the session folder:

```
agent/sessions/<id>/context.json        the window that is sent (compactable)
agent/sessions/<id>/conversation.json   every chunk, all the way back (append-only)
agent/sessions/<id>/chunkpaction.json   the raw chunks of each collapsed section
```

Its shape is the conversation log's kind of document — versioned, dated, with counts so a
listing can describe an entry without loading its chunks (`utils/chunkpaction.js`). Two
rules carry the value:

- **ids are monotonic and never reused.** The record carries its own counter
  (`nextCapture`) rather than deriving the next id from the entries it happens to hold, so
  a summary that names `capture: 2` keeps meaning what it meant even if an entry were
  dropped. `serializeChunkpaction()` refuses to let the counter fall below the highest id
  in use.
- **the chunks are copied, never referenced.** A later mutation of the live window cannot
  rewrite what a capture already holds — the same rule `serializeConversationLog()` keeps.

The write is **appended, never rewritten** (`utils/chunkpaction-store.js`): the record is
read, one entry is added and the whole file is written back verified byte-for-byte.
Nothing trims, reorders or renumbers. Reading is **forgiving** — a missing file (a session
that never collapsed anything) and an unreadable one (a half-written file, an unknown
version) both answer `null`, never a throw, so a broken capture file cannot block a resume.

## The reader

`read_chunkpaction` is the tool that cashes the pointer:

- **with no `capture`**, it lists what the session holds — id, item, when, how many chunks
  — which is the cheap first move and the reason a summary can name an id without the
  model having to guess;
- **with a `capture`**, it pages (`offset`/`limit`, a negative offset counting from the
  end) or scans (`pattern`, `ignoreCase`, `fixedStrings`, `maxMatches`) the original
  chunks;
- an id this session does not hold is `CAPTURE_NOT_FOUND`, and the refusal names the ids
  that *are* available rather than leaving the model to guess;
- with no session registered there is no folder to read from, so it answers `NO_SESSION`.

The reading half is **shared, not reimplemented**: `captureText()` renders a capture's
chunks with the same `chunkToText()` the summariser was given, and
`utils/capture-window.js#selectCapture` pages and scans that string. So a page or a scan
over a chunkpaction behaves exactly like one over a command capture, and the model reads
back the record it lost rather than a second interpretation of it.

## See also

- The collapse that writes a capture: `docs/context/item-collapse`
- How the pointer survives a standard compaction: `docs/context/compaction`
- The durable sibling it is modelled on: `docs/runtime/conversation-log`
- The in-memory capture it shares its reading half with: `docs/agent/command-capture`
- Implementation: `utils/chunkpaction.js`, `utils/chunkpaction-store.js`,
  `utils/session-store.js`, `tools/read_chunkpaction.js`
- Proof: `tests/chunkpaction.test.js`
