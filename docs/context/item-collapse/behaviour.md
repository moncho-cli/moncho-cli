# Context — the item a chunk belongs to, and the collapse of a solved section

The window is a list of chunks, and the conversation usually knows *which* `task.md`
item it is working on. Saving that relation lets the harness collapse a solved item's
whole section — its reasoning, its tool calls, its results — into one paragraph, so
the window carries "that was solved" instead of the record of solving it. The backlog
entry, and its own caveat:

> because the conversation is saved as chunks with the messages inside, and we usually
> can deterministically know which items from task.md we are solving, if we save that
> information in the chunks (the relation to what item) we can deterministically
> compact all that section into a single paragraph hiding all the reasoning and tool
> calls and other whats, the model at that point only needs to know that was solved, if
> it needs anything it can query back again. this only works when we are 100% sure that
> chunk corresponds to an item.

That caveat is the design, not a footnote: the collapse is **timid by construction**,
and every rule below exists to make it refuse rather than guess.

## The attribution is host state, beside the chunks

- The relation is **not a field on the chunk**. A chunk is the message the provider is
  sent verbatim (`app/context-window.js#request`), so no bookkeeping may ride on it —
  the same rule the append times follow (`utils/chunk-stamps.js`). The attributions
  live in a parallel array, index-aligned with the window, and
  `utils/item-collapse.js#normalizeItems` is the one guard that keeps the two aligned:
  one entry per chunk, a short list padded, a long one trimmed, and anything that is
  not a non-empty string becoming `NO_ITEM`.
- **The item in flight is set by `update_task`**, which is the only component that knows
  it: `start` opens the named item and `complete` moves to the next one in line, both
  reaching the live window through the registry (`utils/host.js#setCurrentItem`). The
  tool's reply reports the item it set (`itemInFlight`) and whether a live window took
  it (`attributionSet`), so the wiring is visible from the tool result.
- **A chunk added while no item is open is attributed to nothing** (`NO_ITEM`), never to
  a guess. That is the whole reason `NO_ITEM` exists: the entry's "100% sure" is
  represented in the data, not in a hope about the model.
- A rewrite follows its chunks **by identity** (`utils/item-collapse.js#alignItems`), the
  way the marks do: a chunk that survives a compaction — the carried user message, the
  kept tail — keeps the item it was written under, and anything new (the summary chunk,
  a collapsed section) belongs to nothing.
- The attribution is **host state, never a chunk**: it is not sent to the provider and
  not a session file of its own. A resumed conversation starts with no attributions,
  which is the safe direction — a collapse needs an attribution to exist.

## The collapse is deterministic and refuses more than it does

`utils/item-collapse.js#collapseCompletedItems` rewrites the window with **no model
call**, so the same window always collapses the same way. A run of chunks is replaced by
one summary only when *all* of these hold:

- **it is contiguous chunks of one item** — a chunk belonging to another item, or to
  none, ends the run (`findItemRuns`);
- **that item is completed** — the caller passes the items `task.md` reports as done, so
  an item still in flight is never touched;
- **it is long enough to be worth it** (`minChunks`, two by default) — replacing one
  chunk with a summary of it is not a saving;
- **it does not cut a tool batch in half** (`cutsToolBatch`) — the same 400 the
  compaction boundary avoids (`docs/context/compaction`): a run that begins with a
  `tool` result whose call sits outside it, or ends with a call whose results sit
  outside it, is skipped and stays verbatim;
- **the summary is smaller than the run** — measured with the same estimator the window
  uses, so a collapse can never grow the window;
- **the whole window is not the run** — something has to remain to send.

A skipped run is **copied through verbatim**, and so is every chunk that belongs to no
item: the rewrite is a walk over the window, not over the runs, so a collapse can never
drop a chunk it did not consider.

## The summary is a pointer, not a retelling

`summarizeRun` derives the text from the chunks themselves — the item, how many chunks,
how many tool calls, and which tools — so it is deterministic and needs no model. It
says the item was solved, and then it **names where the detail went**.

That second half is the part worth getting right, because a pointer is only worth
anything if it can be followed. The uncompacted history *is* the journal
(`app/context-window.js#journal`, written to `conversation.json`,
`docs/runtime/conversation-log`) — but the journal is a file on disk, and no tool reads
it, so "the detail is in the journal" was a promise the model had no way to cash. So the
collapse writes a **chunkpaction capture** of the raw chunks it is about to replace, and
the summary names that id:

```
[collapsed] "wire the reader" — solved and collapsed (3 chunks; 1 tool call; via read_file).
Raw chunks: read_chunkpaction({ capture: 2 }).
```

`read_chunkpaction` reads that capture back, paged or scanned (`docs/context/chunkpaction`),
so "if it needs anything it can query back again" is now a property of the record *and* of
the tool. Two orderings make it safe:

- **the capture is written before the window is rewritten**, and only for a run that
  really collapses. The writer is injected (`options.writeCapture`), so the collapse
  itself stays free of any filesystem and a writer that throws leaves the window
  untouched — a failed capture can never cost the conversation its raw chunks.
- **no writer means no id.** `summarizeRun` then names no capture rather than inventing
  one, and the chunk's `collapsed_capture` is `null`. A pointer that cannot be followed
  is never written.

The replacement chunk is marked `collapsed: true` and carries `collapsed_item`,
`collapsed_chunks` and `collapsed_capture`, so a window can be read to tell a collapsed
section from a real message — the same recognisability the compaction summary has through
its prefix.

## When it runs

`app/item-collapse-runner.js#runItemCollapse` is the wiring half: it takes the items
`task.md` reports as done, hands the window a capture writer bound to the live session,
and reports what was collapsed. `tools/update_task.js` calls it on `complete` — the one
action that finishes a section — and reports the captures in its own reply. `start` opens
an item, `step` ticks one still in flight and `status` is a metadata edit, so none of
them collapses anything.

With no window registered (a bare tool call, the tool-level suites) or no session (no
folder to write a capture into) the runner is a **silent no-op**, which is the same shape
every other registry-backed step has.

## See also

- Implementation: `utils/item-collapse.js`, `app/context-window.js`,
  `utils/host.js`, `tools/update_task.js`
- The other parallel array, and the rule it shares: `docs/interface/session-stamps`
- The boundary rule a collapse must not break: `docs/context/compaction`
- Where the full record lives: `docs/runtime/conversation-log`
- Proof: `tests/item-collapse.test.js`
