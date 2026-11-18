status: done

# Tool batches: up to five simultaneous calls, one signature-annotated envelope

Taken from `task-backlog.md`:

> tool calling should allow the model to ask with an array of tools, up to 5
> simultaneous calls. the responses would be added in the context enclosed in
> `<tool-multicall result><tool-call name=call-signature>...</tool-call></tool-multicall result>`
> where call signature is a param type summary of how the tool was called.
> example: `"name=string(5)"`.

The model can already answer with a `tool_calls` array, but the loop runs every
call one after another, each result landing as a plain `tool` chunk. Nothing caps
a batch, nothing dispatches the calls together, and nothing records *how* a call
was shaped, so the model cannot tell a 5-call simultaneous request from a chain.

## What a batch must do

| Step | Behaviour |
| ---- | --------- |
| plan | the calls of one assistant message split at `MAX_PARALLEL_TOOL_CALLS` (5): the first five run, the rest are refused |
| run | the accepted calls are dispatched together and awaited together, results collected in the model's **call order**, not completion order |
| refuse | a call beyond the cap is answered with a `TOO_MANY_TOOL_CALLS` result asking for a smaller batch — the provider's id pairing stays complete |
| store | one `tool` chunk per call, in call order, whose body is the result inside a `<tool-multicall result calls=N>` envelope holding one `<tool-call name="<signature>">` element |
| signature | `read_file(path=string(11), intent=string(12))` — the tool name plus its parameter types, the summary the backlog asks for |

## Constraints

- The intent stays the **first line** of a result chunk (`docs/agent/tool-call-contract`),
  so existing sessions and readers keep working; the envelope follows it.
- `parseToolChunk()` accepts both shapes: an enveloped chunk unwraps to its exact
  body, and a chunk written before this change keeps its current reading.
- One call still gets one chunk: the provider's `tool_calls`/`tool_call_id`
  pairing is untouched, and the token meter keeps announcing per chunk.
- The batch orchestrator (`app/tool-batch.js`) is a new module rather than growth
  in `app/conversation-manager.js` (297 lines): the manager delegates to it, and
  every file stays under 300 lines.
- A batch is dispatched simultaneously, so its calls must be independent — the
  trade-off is stated in the spec, never hidden.

- [x] **signature and envelope for one tool call** — `app/tool-call-format.js` gains `formatCallSignature()` and the `<tool-multicall result calls=N>`/`<tool-call name="…">` grammar, and `formatToolResultChunk()`/`parseToolChunk()` round-trip it while still reading an un-enveloped chunk.
- [x] **run the batch: five at a time, in call order** — `config/constants.js` gains `MAX_PARALLEL_TOOL_CALLS`/`TOO_MANY_TOOL_CALLS`, `app/tool-batch.js` holds `planToolBatch()`/`dispatchToolCalls()`/`handleToolCalls()`, and `ConversationManager#handleToolCalls` delegates to it.
- [x] **document and prove the tool batch** — a `docs/agent/tool-multicall` spec (registered in `docs/index.yaml`) states the cap, the simultaneous dispatch, the envelope grammar and the signature; `tool-call-contract`, `session-replay` and `usage-refresh` are updated; `tests/tool-multicall.test.js` proves the signature, the envelope round-trip and the replay of an enveloped chunk, and `tests/tool-batch.test.js` proves the cap, the simultaneous dispatch in call order, the refusal and the chunks the loop stores.

## Done when

- the spec exists, is registered, and names real `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines;
- a scratch probe under `agent/utils/` confirmed the batch shape and the concurrency before the tests were written, and is deleted afterwards.
