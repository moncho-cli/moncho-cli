# Agent — the conversation's own identity in the request

A conversation lives in a folder of its own — `agent/sessions/<id>/`, holding its
`task.md`, its `implementation_plan.md` and its `context.json`
(`docs/runtime/session-store`, `docs/agent/task-tracking`). The host knows all of that.
The model used to learn it only when `update_task` answered, so on a fresh session it had
nothing to go on and went looking: it grepped the tree for the folder it was already
sitting in. This spec fixes the fix — the identity is **handed over up front**, once, as
data the model never has to compute.

## The block

Every request to the model carries one `system` message, right after the agent prompt:

```
[session] this conversation's own folder is agent/sessions/<id>/ — your session id is <id>.
These files are yours; never grep for the folder:
- task.md                   agent/sessions/<id>/task.md
- implementation_plan.md    agent/sessions/<id>/implementation_plan.md
- conversation record       agent/sessions/<id>/context.json
The folder is fixed for the whole conversation ... update_task reports these same paths.
```

`formatSessionBlock()` renders it from facts alone — the id and the resolved paths — and
answers the empty string when any of them is missing, so a partial answer is never sent.
`sessionBlockMessage()` reads the live session registry and wraps the text in the
`{ role: 'system', content }` shape the request needs.

The paths are **resolved, not patterned**. The model is never told to build
`agent/sessions/<id>/…` itself: the id of a fresh session did not exist when the prompt
was written, and a resumed conversation may sit in a folder the prompt cannot know. The
same reasoning already governs `update_task`'s reply, which reports the resolved
`taskFile`/`planFile` (`docs/agent/task-tracking`); the block is that reply, moved to the
moment the model actually needs it.

## Why the request prelude, not a chunk

`ContextWindow.request()` takes a prelude that rides the request without entering the
window — the seam `docs/context/call-pulse` documents. The block belongs there, for the
same three reasons the pulse line did:

- **It is host data, not conversation.** A chunk would land in the session record
  (`context.json`) and in the journal, so every save would carry a copy of text the host
  can regenerate at any time. `sessionBlockMessage()` is therefore never added to the
  window, and the block never appears in a replayed transcript.
- **It must reach the model even when the window is compacted.** A compaction replaces the
  older share of the window with a summary; host identity is not part of the dialogue and
  must not be summarised away.
- **It costs the prompt cache nothing.** Unlike the per-call pulse line — whose wording
  changed on every request and which is why it was paused — the block is **constant for
  the whole session**: the id, the folder and the paths never move mid-conversation. A
  later request therefore repeats the earlier prefix byte-for-byte and appends, which is
  exactly the property the provider cache needs.

`ConversationManager.beginModelCall()` composes the prelude as
`[sessionBlockMessage(), this.pulse.message()]`; the `null` entries drop out in
`request()`'s `filter(Boolean)`, so a session-less process sends the request it always
sent.

## A session-less process sends nothing

With no session registered — a bare tool invocation, a tool-level suite, a stub session —
`sessionBlockMessage()` answers `null`. The block is a property of *a conversation*, so a
process without one has no identity to state; inventing a placeholder would be the same
mistake as falling back to a project-root `task.md`.

## The summariser never carries it

The context-compaction call opts out of the agent system prompt
(`systemPrompt: false`, `docs/context/compaction`) and is issued by the compaction runner
rather than by `beginModelCall()`, so the block cannot ride a summariser request. The
summariser is a neutral internal call and must not answer as the conversation.

## See also

- Implementation: `utils/session-context.js`, `app/conversation-manager.js`,
  `app/context-window.js`, `utils/tracking-store.js`, `utils/session-store.js`,
  `utils/host.js`
- Where the folder and its files live: `docs/runtime/session-store`
- The tracking pair the block names: `docs/agent/task-tracking`
- The prelude seam and its cache rule: `docs/context/call-pulse`
- Proof: `tests/session-context.test.js`, `tests/call-pulse-loop.test.js`
