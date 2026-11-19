# Context — token usage per model

The status-bar meter answers *how full is the window right now*. It is a view, not
a record: the number moves as the conversation grows and dies with the process.
The question a user actually asks of a long-running agent is a different one —
**how much did each model consume?** — and answering it needs an accounting table
that outlives the turn. This spec fixes that table; the implementation is linked
below.

## What is counted, and against which model

- The unit of account is the **provider call**, not the chunk. One turn with two
  tool calls is **two** calls: the answer that asked for them and the answer that
  followed their results. The results cost nothing themselves — they are only
  *sent* with the next call. A compaction that fires mid-turn is a call too, and
  it is counted like any other.
- A call is recorded against the **model that answered it**, keyed by the same
  label the status bar shows (`config/constants.js#describeModel`). A model that
  was never used has no entry rather than a row of zeroes.
- An unnamed model still counts, under the placeholder key
  (`utils/usage-stats.js#UNKNOWN_MODEL`): a dropped count would silently
  under-report the session.

## Exact versus estimated

| What the provider did | How the call is counted |
| --------------------- | ----------------------- |
| reported `usage` counters | `exactRequests` + its own numbers |
| reported nothing | `estimatedRequests` + the measured prompt and answered text |

- The provider spellings are normalised in **one** place
  (`api/ollama.js#normalizeUsage`): OpenAI's `usage.prompt_tokens` /
  `completion_tokens` / `total_tokens`, and Ollama's flat `prompt_eval_count` /
  `eval_count` with the total summed when absent.
- A response with no counters normalises to **null**, never to zero. That
  distinction is the whole point: the accounting layer must know whether a number
  is a reading or a guess.
- The fallback reuses the window's characters-per-token rule
  (`utils/tokens.js#estimateTextTokens`), so an estimate stays comparable with the
  meter instead of being a second, unrelated unit.
- A row therefore always adds up: `requests === exactRequests + estimatedRequests`.
  Two models can be compared on their exact counts alone; mixing the two kinds
  silently is what the split exists to prevent.

## The table

One entry per model, holding `requests`, `exactRequests`, `estimatedRequests`,
`promptTokens`, `completionTokens` and `totalTokens`.
`utils/usage-stats.js#normalizeModelUsage` is the single normaliser every reader
and writer goes through:

- counters are clamped to non-negative integers, so a hand-edited file or an
  older schema cannot produce a negative total;
- an entry under an empty name is **dropped**, not merged into someone else's
  model;
- a malformed entry becomes zeroes instead of throwing — a broken table must never
  cost the user their session.

### Working time on the same entry

The same entry also carries `thinkingMs` and `toolMs`: how long that model spent
thinking and how long the tool calls it asked for spent resolving
(`docs/context/working-time`). They are a **different unit** from the counters, so
they are written by a different function:

- `applyCall()` never touches the time, and `applyTime()` never touches the tokens.
  A call retried twice is one request but three thinking spans, and both facts have
  to survive;
- `createUsageMeter().recordTime(model, span)` is the second mutator, and a model
  that never worked simply reports zero — which is why a table written before the
  counter existed keeps exactly the row it always had;
- `formatUsageRow()` appends `· working <dur> (thinking <dur>, tools <dur>)`
  **only when some time was worked**, so `/usage` gained a suffix rather than a
  column of zeroes.

`createUsageMeter()` is the live object the loop records into. `table()` returns a
**copy**, so a caller can store a snapshot without it changing under its hands,
and `replace()` installs a stored table as the live one, which is what a resume
needs: the session file is the accounting record of that conversation, so
resuming **continues** the counts instead of starting a second set beside them.

## Persistence

- The session file carries the table as `usage`
  (`utils/session-store.js#serializeSession`), next to `stats` and the chunks, so
  the conversation and what it cost travel together.
- `parseSession()` normalises the block on read and tolerates its **absence**: a
  session written before the table existed still loads and resumes
  (`docs/runtime/session-store`). `sessionUsage()` is the accessor a resume uses.
- `main.js` saves the table with every turn, so `/usage` survives a restart of the
  process, and a resumed session reports the whole conversation, not just the part
  since it was reopened.

## Reporting

`/usage` (`app/commands.js#usageCommand`) prints one line per model, alphabetical
so two runs can be compared line by line, with the exact/estimated split spelled
out, and a total line when more than one model was used. An empty table says so
instead of printing a table of zeros. The status bar keeps showing the *window*:
the two views answer different questions and neither replaces the other.

## See also

- Implementation: `api/ollama.js`, `utils/usage-stats.js`,
  `app/conversation-manager.js`, `utils/session-store.js`,
  `app/session-recorder.js`, `app/commands.js`, `main.js`
- The live meter: `docs/context/usage-refresh`, `docs/context/token-accounting`
- Where the numbers are stored: `docs/runtime/session-store`
- The command surface: `docs/interface/commands`
- Proof: `tests/model-usage.test.js`