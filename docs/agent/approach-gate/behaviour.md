# Agent — the stated approach seeds the turn

A turn has **one seed**: a short statement, in prose, of what was understood and what the
next operations are. It rides the **same** assistant message as the calls it introduces,
and everything after it grows from it — the later batches are the operations that prose
promised, and the closing reply is prose too, so the seed is written once and nothing
repeats it.

```
user message → model prose (the seed) → as many batches as the work needs → user message → …
```

The rule is deliberately phrased on the message and not on order — a model cannot tell a
"first" answer from a later one, so a rule about being *first* asks it to police a boundary
it cannot observe, while a rule about *this message* names the defect it can see and the
fix it can write. It is stated once per turn, not once per tool call: `app/turn-runner.js`
latches the first real prose it reads (`addressed`), and every batch after that is an
ordinary batch.

This is deliberately **not** something the model is merely asked to do. The rule has to
be deterministic — the imperative came from the backlog as "not something we expect the
model to understand to do on its own" — while the tool list stays **advertised**: the
point is not to hide the tools, it is to have the seed say what they are for.

## The policy: `app/approach-gate.js`

Pure values, so the rule is testable without a provider:

- `isApproachAnnouncement(content)` is the whole test. **Prose is it**: a message whose
  `content` is real text carries the seed, and the provider's bare-call shape
  (`content: null` next to `tool_calls`) does not. Whitespace does not count.
- `approachRefusal()` is the refusal the **whole batch** gets, in the shape
  `app/tool-guard.js#guardToolCall` already understands (`{ reason, code, mode,
  guidance }`), so the batch's refusal path — one `tool` chunk per call, a bright
  `✖ Refused …` row for the reader (`docs/agent/tool-refusal`) — is reused rather than
  reimplemented. The reason (`APPROACH_REFUSAL_REASON`) is **one string**: the row and
  the JSON the model reads are built from it.
- `formatApproachRefusalLine({ name })` is the reader's row, and it classifies as the
  palette's own `refusal` kind.
- `needsApproach({ announced, refusals, max })` is the **bound**.

## The enforcement: `app/turn-runner.js`

The loop reads the assistant message it just received, and remembers one thing: whether
the turn already has a seed.

- A message that **carries prose** writes the seed, and that prose travels on the
  assistant chunk the calls ride (`app/tool-batch.js#handleToolBatch` stores it as the
  chunk's `content`). One chunk, two readers: the model keeps the seed in its context, and
  the transcript shows it — printed **before** the calls, which is also where
  `app/session-replay.js` puts it when the session is resumed.
- A message that asks for tools **without** prose is refused **whole** *while the turn has
  no seed*. The loop passes a per-batch gate override (`handleToolCalls(calls, signal,
  { gate })`), so the manager needs no notion of a seed: every call of the batch becomes a
  structured `TOOL_REFUSED_BEFORE_APPROACH` result, no tool is invoked, and the provider
  still gets one result per `tool_call_id`. The refusal is a **chunk**, so it is part of
  the context the next call sends — which is what makes the model's next answer write the
  seed instead of another bare call.
- The seed **latches**: once a message has carried real prose, `addressed` stays true for
  the rest of the turn, so the batches that follow need no prose of their own. That is what
  keeps the rule a seed and not a per-batch ritual — one arc of work with one statement of
  intent at its head.
- The model is asked again through a transient notice
  (`APPROACH_REQUIRED_NOTICE`, `code: 'approach-required'`), which is *news* rather than
  history and expires like every other notice (`docs/interface/notice-overlay`).

### The bound: the rule never starves the turn

A refusal that could repeat forever would let a stubborn model deadlock the turn, so the
rule is **enforced with a bound** rather than enforced absolutely:

- After `APPROACH_MAX_REFUSALS` refusals in one turn (from the environment,
  `config/constants.js`, default **2**), the batch **runs**, and the skip is announced
  once (`APPROACH_SKIPPED_NOTICE`, `code: 'approach-skipped'`). The refusal count is per
  turn, not per session: a new user message is a new seed to write.
- `approachMaxRefusals: 0` — the default of `ConversationManager` — means **no bound is
  declared and nothing is policed at all**. `main.js` is the one place that turns the
  rule on, so every existing wiring and every stub session behaves exactly as it did.

## Where it is stated to the model

`config/prompt.md` §2.1 states the rule the way it is enforced: the stated approach is
**the seed of the turn** — what was understood and what the next operations are, in one or
two sentences, on the same message as the calls it introduces, with the rest of the turn
growing from it rather than repeating it. The prompt is the *instruction*; the loop is the
*guarantee*. Both are phrased on the message in hand, because order is the one thing the
model cannot recover from its own context: it sees the message it writes and the ones
already sent, and "first" is a fact about a boundary it was never shown.

## See also

- Implementation: `app/approach-gate.js`, `app/turn-runner.js`, `app/tool-batch.js`,
  `app/conversation-manager.js`, `config/constants.js`
- The gate the refusal reuses: `app/tool-guard.js`, `docs/agent/tool-refusal`
- The batch the rule refuses: `docs/agent/tool-multicall`
- Proof: `tests/approach-seed.test.js` (the policy and the wording the model reads),
  `tests/approach-gate.test.js` (the enforcement in the turn loop),
  `tests/session-replay.test.js`
