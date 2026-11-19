# Agent — one tool batch: five calls at once, results in one envelope

A model can answer with several `tool_calls` in a single assistant message: five
reads, a grep and a blob, a set of independent probes. The loop used to run them
one after another, so a simultaneous request cost the sum of its calls and the
model had no way to tell a batch from a chain. This spec fixes what a batch *is*:
the cap, the simultaneous dispatch, the call order and the envelope each result
travels in. Implementation: `app/tool-batch.js`.

## The batch

- One assistant message's calls **are** one batch. `planToolBatch()` splits them
  at `MAX_PARALLEL_TOOL_CALLS` (5): the first five are **accepted**, the rest are
  **refused**. Both halves keep the model's order, and a call is accepted by
  **position**, never by name — the provider pairs one result per `tool_call_id`,
  so nothing may be dropped or reordered.
- The accepted calls are dispatched **together** (`Promise.all` over
  `dispatchToolCalls()`) and awaited together, so the batch costs the slowest call
  rather than the sum of all of them. The outcomes are returned in **call order**,
  not completion order: a fast second call cannot arrive before a slow first one.
- A batch is dispatched simultaneously, so its calls must be **independent**. Two
  calls that write the same file, or a call that reads what the previous one
  wrote, must be asked for in separate messages. The trade-off is the point of the
  feature and is never hidden.
- A tool that throws becomes an `isError` outcome (the same
  `Error executing <tool>: <message>` body as before), and an **unknown tool
  name** is an error outcome too — neither can fail the whole batch.
- `signal.aborted` **skips** the calls instead of starting them: a cancelled task
  must not dispatch work the user already cancelled.

## The envelope

Every result is stored in the `tool` chunk that answers its call, in the same
`intent:`-first shape as always (`docs/agent/tool-call-contract`), with the result
wrapped in a multicall envelope:

```
intent: read the fixture
<tool-multicall result calls=2>
<tool-call name="read_file(path=string(11), intent=string(7))">
<file relative_path="a.txt" ...>…</file>
</tool-call>
</tool-multicall result>
```

- `calls=N` is the size of the **batch the assistant asked for**, so the model can
  tell a lone call from one of five asked at the same time.
- `<tool-call name="…">` carries the **call signature**: the tool name plus the
  type of every parameter it was called with, from `formatCallSignature()` —
  `read_file(path=string(11), intent=string(7))`. Lengths, never contents: the
  shape of the call is recorded while the payload travels in the body, so the
  annotation adds no duplicate of the output. A parameter that is not a string is
  its type name (`number`, `boolean`, `null`, `array`, `object`), and arguments
  that could not be parsed report their raw size (`…(raw=string(8))`).
- **One chunk per call, one call per chunk.** The provider's `tool_calls` /
  `tool_call_id` pairing is untouched: an enveloped chunk still answers exactly
  one call, so the token meter keeps announcing per chunk
  (`docs/context/usage-refresh`) and a lone call is still a lone chunk.
- A **refused** call is answered, never dropped: its chunk carries an `[error]`
  body holding a structured refusal — `{ status: 'error', code: 'TOO_MANY_TOOL_CALLS',
  guidance, max }` — with the very same signature, so the model sees *which* call
  was dropped and is told to ask for a smaller batch.

## The pre-dispatch gate

- Before a tool is looked up, every accepted call passes the **injected gate**
  (`app/tool-guard.js#guardToolCall`). The gate answers `null`/`undefined`/`false`/
  `true` to allow the call, or an object (`{ reason, code?, mode?, guidance? }`) to
  refuse it; any other answer — and a gate that throws — is a refusal, so a broken
  policy **fails closed** instead of silently granting everything.
- A refusal never invokes the tool. It becomes a normal `[error]` outcome whose body
  is `formatGuardRefusal()`'s JSON (`code`, `tool`, `mode`, `message`,
  `guidance`), stored in the call's own `tool` chunk, so the provider's pairing is
  untouched and the model learns *which* call was blocked and why. The batch then
  reports it as `guarded` next to `executed` and `refused`.
- With **no gate installed** the batch behaves exactly as it did before: the abort
  check, the unknown-tool error and the throwing-tool error are unchanged. What the
  gate decides is a session policy (`docs/interface/modes`), never the batch's
  business.

## Reading it back

- `formatMulticallEnvelope()` writes the envelope and `parseMulticallEnvelope()`
  reads it as `{ calls, elements, entries }`; a text that is not an envelope
  returns `null` rather than throwing.
- The header's element count is what makes the parse unambiguous: a `calls=1`
  envelope is read greedily to the **last** `</tool-call>`, so a body that itself
  quotes the envelope (a session file fetched by `read_file`) round-trips
  byte-for-byte. An envelope declaring several elements is split on each closing
  line, so such a body must not carry one on a line of its own.
- `parseToolChunk()` unwraps the envelope **before** it looks for the `[error]`
  marker, so the transcript shows the tool's own output: the replay
  (`docs/interface/session-replay`) prints the unwrapped body and keeps the intent
  in the block header. A chunk written before the envelope existed keeps its
  historical reading: `signature` is `''` and `calls` is `1`.

## The loop

`ConversationManager#handleToolCalls()` is wiring only: it hands the calls, the
window, the log, the tool map and the `notifyContextChange` hook to
`handleToolBatch()`, which appends the assistant chunk, announces every call of
the batch **before** any of them runs (they are in flight together; printing them
per completion would misreport the batch as a chain), dispatches, and stores one
chunk per call. It returns `{ compactionRequested, executed, refused,
simultaneous, order }`, and the deferred-compaction request
(`docs/context/compaction`) is detected per result exactly as before.

## See also

- Implementation: `app/tool-batch.js`, `app/tool-guard.js`,
  `app/tool-call-format.js`, `config/constants.js`,
  `app/conversation-manager.js`
- The chunk a tool result lives in: `docs/agent/tool-call-contract`
- Replaying an enveloped chunk: `docs/interface/session-replay`
- The meter's per-chunk announcements: `docs/context/usage-refresh`
- Proof: `tests/tool-multicall.test.js`, `tests/tool-batch.test.js`,
  `tests/tool-guard.test.js`
