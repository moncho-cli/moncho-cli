# Runtime — per-chunk provenance

The session record held the conversation but not **what produced it** or **what it
weighed**. That is fine while the code is still, and useless the moment it is not: a change
to the system prompt, to a tool's description, to the collapse or to the compaction is a
claim about behaviour, and without a per-chunk record of the build and the cost there is
nothing to compare a before against an after. The claim cannot be told from a regression.

So each chunk now carries two facts, and they are the two that cannot be recomputed later:

| fact | why it cannot wait |
| ---- | ------------------ |
| `moncho` — **Moncho's** version, the build that wrote the chunk | the running build changes; a record that does not name it cannot say which chunks came from which |
| `tokens` — the atomic estimate for that chunk alone | a *total* can be recomputed from the parts, but the parts cannot be recovered from a total |

They are written beside each chunk in `conversation.json`, the file that already keeps the
whole uncompacted history (`docs/runtime/conversation-log`):

```json
{
  "chunks": [ { "role": "user", "content": "…" } ],
  "meta":   [ { "moncho": "0.25.0", "tokens": 137 } ],
  "metaSummary": { "chunks": 1, "tokens": 137, "unknown": 0,
                   "versions": [ { "moncho": "0.25.0", "chunks": 1, "tokens": 137 } ] }
}
```

`metaSummary` is there so the cheap question — *did 0.24.0 cost more per chunk than
0.23.0?* — is answerable from the file without loading the chunks at all.

## Two rules decide the shape

- **A parallel array, never a field on the chunk.** A chunk is what the provider is sent
  verbatim (`app/context-window.js#request`), and a strict OpenAI-compatible endpoint can
  reject an unknown key — the rule the append times (`docs/interface/session-stamps`) and
  the item attributions (`docs/context/item-collapse`) already keep.
- **The window and the journal hold the *same objects*.** `add()` pushes one object into
  both, so a bookkeeping field would not merely be sent: it would be sent *and* stored,
  changing what a stored conversation is. A parallel array cannot leak that way, and
  `tests/chunk-meta.test.js` asserts the chunk comes out exactly as it went in.

## The version is Moncho's, and the field says so

This is the part that is easy to get wrong in a way nobody notices for months. The field
is called `moncho` — not `app`, not `version` — and that name is load-bearing:

- **In the maintainer flow** the agent runs *on* this repository, so "the version" and
  "the project's version" are the same number and any name would do.
- **In the user flow** the agent runs *inside someone else's checkout*, which has a
  `package.json#version` of its own. A field called `app` there reads as *that* project's
  version, and the obvious future "improvement" — read the version next to the working
  directory — would fill the record with a number that has nothing to do with the build
  that produced the chunk. The dataset this exists to build would be quietly wrong.

The name says whose version it is, and the **value** is resolved module-relative:
`app/brand.js` imports `../package.json`, so it is Moncho's own manifest in both flows and
never the cwd's (`Dockerfile.agent` relies on the same property when it bakes the payload
in). `app/conversation-manager.js` passes it as `monchoVersion`, and
`ContextWindow#monchoVersion` stamps it.

A comment is not enough for an invariant a later change can break in silence, so
`tests/chunk-meta.test.js` proves both halves by running a **decoy**: a node process whose
working directory holds a `package.json` declaring a different version. The stamped value
is still Moncho's.

## Aligned with the journal, not the window

The provenance belongs to the **journal** (`ContextWindow#journalMeta`), and that choice
is what keeps the mechanism small. The window is rewritten by a compaction, so its
bookkeeping needs `alignStamps()`-style machinery to follow chunks through a rewrite. The
journal is **append-only** — a compaction never touches it — so an entry is written once,
as the chunk enters, and is never re-aligned.

The consequence is worth stating: a compaction shrinks the window and leaves the
provenance of everything that was ever said exactly where it was.

## Written only when there is something to write

- The field is **optional in both directions**. `serializeConversationLog()` writes `meta`
  only when a caller supplies one, so a log without it is byte-for-byte what it always
  was, and a file written before the field existed still parses. `readConversationLogMeta()`
  answers `null` for such a file — the honest answer, not a guess.
- `normalizeMeta()` forces one entry per chunk: a short list is padded with `null` and a
  long one trimmed, so a hand-edited file cannot shift provenance onto the wrong rows.
- An entry that cannot be estimated keeps its version: the build is the half that cannot
  be recomputed, so it is never thrown away for the half that can.

## See also

- The file it rides in, and the journal it is aligned with: `docs/runtime/conversation-log`
- The same parallel-array rule for append times: `docs/interface/session-stamps`
- Where the version comes from: `app/brand.js#BRAND_VERSION`
- Implementation: `utils/chunk-meta.js`, `app/context-window.js`,
  `utils/conversation-log.js`, `utils/conversation-log-store.js`, `app/session-recorder.js`,
  `app/session-save.js`, `app/commands.js`, `app/conversation-manager.js`
- Proof: `tests/chunk-meta.test.js`
