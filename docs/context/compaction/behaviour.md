# Context — compaction

When the context window no longer fits its budget, the older part of the conversation is replaced by a single summary and the newest part is kept verbatim. This spec fixes the split rule, the summary contract, and the failure behaviour; the implementation is linked below.

## The split is configurable, and its wording follows the config

The entire conversation history is divided by token mass: the newest portion is kept verbatim while older context is summarised. This balance prioritises responsiveness over historical granularity when both are needed. How aggressively to compact is a **deployment decision**, so it is one configured factor rather than a constant baked into the prose:

- `COMPACTION_OLD_RATIO` (`config/constants.js`) is the **one knob**: the older share of the window that is replaced by a single summary chunk. It defaults to `0.7` and is overridable through the `COMPACTION_OLD_RATIO` env var, which accepts `0.7`, `70` and `70%` alike; anything out of range falls back to the default.
- `COMPACTION_KEEP_RATIO` is **derived** (`1 - COMPACTION_OLD_RATIO`), so the two always sum to 1 and no second env var can contradict the first.
- The split is driven by **token mass**, not chunk count: the newest chunks are accumulated until they hold at least the keep ratio of the window's tokens; everything older is the block to summarise. Token mass prevents two huge chunks from skewing the split.
- **Every message that names the split derives it from the config** through `describeCompactionSplit()` (`utils/compaction.js`), which reports the two shares as whole percentages: the CLI budget line (`main.js`), the `compact_context` description and result messages (`tools/compact_context.js`). A message therefore cannot drift from the code again, and an operator who overrides the ratio sees the figure the code actually uses.
- The tail is always non-empty: the newest chunk is never evicted, and a window of two or more chunks is compactable, but a single-chunk window remains untouched.
- **The boundary never cuts a tool batch in half.** A provider that speaks the OpenAI chat schema pairs every assistant message carrying `tool_calls` with one `tool` message per call id. A window whose kept tail begins with such a `tool` message — its assistant message having been summarised away — is refused with a 400, and keeps being refused because the history is carried from call to call: the session is stuck while a new one works. So the one unsafe boundary (between a call and its results) is moved: the **whole batch is kept**, and the boundary moves up to where the batch starts.
  - Keeping the batch is the safe direction: the kept tail is never empty and never starts with a result. Summarising the batch instead would evict the *last* chunk of the window along with it, leaving nothing to send — and a window with nothing in it makes the provider answer a request it cannot answer, over and over. The cost of keeping the batch is that the window may stay over budget for one turn; the cost of the other choice is a session that never works again.
  - The rule is `alignSplitToToolBatches()` (`utils/compaction.js`).

## The summary contract

The summariser is asked for markdown covering, in order: original intent, tasks done (with how each was verified), things pending, and key facts (paths, commands, identifiers, errors). It must not add preamble or meta commentary.
- The summariser call is a **neutral** model call: it does **not** inherit the agent's system prompt, so it describes the work instead of continuing it.
- The summary chunk is prepended to the kept tail, marked `compacted: true`, and records how many chunks it replaced. Its text starts with a recognisable prefix so an agent reading the window can tell a summary from a real message.
- After compaction the window is strictly smaller than before.

## The request is self-contained

Compaction is a **single, self-contained request**: an instruction that says so, plus the chunks that are about to be evicted. Nothing else rides it — not the agent system prompt (`systemPrompt: false`), not the pulse line, not the conversation being kept.
- `SUMMARIZER_SYSTEM_PROMPT` states that the message *is* the whole instruction and that the payload is the entire record, so the summariser never assumes context it was not given.
- For the same reason **`config/prompt.md` says nothing about compaction at all**: no tool bullet, no window section, no advice. The host decides when the window is compacted, so teaching the mechanism to the agent only spends context on a decision the model never makes.
- The carried message is therefore *independent of the summary*: a summary that never mentions the user's words still leaves them in the window verbatim.

## The user's own words survive

A summary paraphrases, and the prompt the user actually typed is the one thing that must not drift. So the **last message the user wrote inside the block being summarised is carried over verbatim** (`lastUserChunk()`), and the window after a compaction reads:
- The chunk is re-inserted **by reference**: no marker is added to it, no field is rewritten, and its text is byte-for-byte what the user sent.
- The carry is a fidelity rule, never a licence to grow the window: when re-inserting the message would not still leave the window smaller than before (the user's message *was* the bulk of the evicted block), the carry is dropped and the summary stands alone.
- A block that holds no user chunk carries nothing. The report says which happened through `carriedChunks` (`0` or `1`), and the transcript line and the TUI marker name the carried message when there is one.

## The announcement

- A compaction is announced **twice** in the conversation thread: once when it starts and once when it is done. The first one is there because the summariser call takes time — the thread must not go quiet while the window is rewritten.
- The starting line is written **before** the summariser call, so the order of the transcript is the order of the events.
- A window that needs no compaction announces nothing at all: the announcement belongs to a compaction, not to a turn.
- A compaction that fails has already announced that it started; the failure is reported on its own line.

## Failure behaviour

- An empty or whitespace-only summary is **rejected**: the compactor throws and the window is left exactly as it was. A compaction must never silently discard history.
- A provider error propagates the same way — the window is untouched.
- If there is nothing to compact (no older block), the result is `compacted: false` with reason `nothing_to_compact`, not an error.
- The host loop treats a failed compaction as non-fatal: it reports the skip and continues the task.

## The window object

- `ContextWindow.needsCompaction()` is true when the estimated request size exceeds the budget; it also carries where the budget came from (config override, provider API, or default) so the UI can show both.
- `compact()` returns a report and records it in a compaction history; a within-budget call is a no-op with reason `within-budget` unless forced.
- The `compact_context` tool reaches the **live** window through a host registry. It either reports a model-free dry run (`WITHIN_BUDGET`, or `COMPACTION_REQUESTED` with `defer: false`) or *requests* a real compaction by returning `defer: true`, which the host loop then performs because it owns the provider connection. Without a registered window it returns `NO_CONTEXT_WINDOW`.
- There are **three ways in**, and they all reach the same state
  (`ConversationManager#maybeCompact()`): the budget check the turn loop runs, the
  `compact_context` tool the model calls, and the `/compact [force]` slash command the
  *user* types (`docs/interface/commands`). A user-driven compaction restarts the
  model-call pulse (`docs/context/call-pulse`), exactly like the forced one the turn
  loop performs.

## Implementation

- `utils/compaction.js`, `utils/compaction-render.js`, `app/context-window.js`, `tools/compact_context.js`, `utils/host.js`, `app/conversation-manager.js`
