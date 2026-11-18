# Context — compaction

When the context window no longer fits its budget, the older part of the
conversation is replaced by a single summary and the newest part is kept verbatim.
This spec fixes the split rule, the summary contract, and the failure behaviour; the
implementation is linked below.

## The 80 / 20 split

- The window is an ordered array of **chunks** (chat messages).
- The split is driven by **token mass**, not chunk count: the newest chunks are
  accumulated until they hold at least the keep ratio (20%) of the window's tokens;
  everything older is the block to summarise. Token mass prevents two huge chunks
  from skewing the split.
- The tail is always non-empty: the newest chunk is never evicted, and a window of
  a single chunk is never compacted.
- A dry run reports the exact split (`olderChunks`, `keptChunks`, `olderTokens`,
  `keptTokens`, `afterTokens`) without calling a model.

## The summary contract

- The summariser is asked for markdown covering, in order: original intent, tasks
  done (with how each was verified), things pending, and key facts (paths,
  commands, identifiers, errors). It must not add preamble or meta commentary.
- The summariser call is a **neutral** model call: it does **not** inherit the
  agent's system prompt, so it describes the work instead of continuing it.
- The summary chunk is prepended to the kept tail, marked `compacted: true`, and
  records how many chunks it replaced. Its text starts with a recognisable prefix
  so an agent reading the window can tell a summary from a real message.
- After compaction the window is strictly smaller than before.

## Failure behaviour

- An empty or whitespace-only summary is **rejected**: the compactor throws and the
  window is left exactly as it was. A compaction must never silently discard
  history.
- A provider error propagates the same way — the window is untouched.
- If there is nothing to compact (no older block), the result is
  `compacted: false` with reason `nothing_to_compact`, not an error.
- The host loop treats a failed compaction as non-fatal: it reports the skip and
  continues the task.

## The window object

- `ContextWindow.needsCompaction()` is true when the estimated request size exceeds
  the budget; it also carries where the budget came from (config override, provider
  API, or default) so the UI can show both.
- `compact()` returns a report and records it in a compaction history; a
  within-budget call is a no-op with reason `within-budget` unless forced.
- The `compact_context` tool reaches the **live** window through a host registry.
  It either reports a model-free dry run (`WITHIN_BUDGET`, or
  `COMPACTION_REQUESTED` with `defer: false`) or *requests* a real compaction by
  returning `defer: true`, which the host loop then performs because it owns the
  provider connection. Without a registered window it returns `NO_CONTEXT_WINDOW`.

## See also

- Implementation: `utils/compaction.js`, `app/context-window.js`,
  `tools/compact_context.js`, `utils/host.js`, `app/conversation-manager.js`
- Proof: `tests/harness-tools.test.js`, `tests/conversation-manager.test.js`
