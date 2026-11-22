# Runtime — provider diagnostics

A provider that refuses a request says why **in its own body**, and the harness used to
throw that body away: the call raised `HTTP error! status: 400` and the operator was
left with a number and nothing to act on. This spec fixes what the harness records when
a provider answers with a non-200, and what it raises.

## Why the record exists

A chat provider refuses a request because of its **shape**, not because of its size, and
the shape that breaks is almost always the **tool-call pairing**:

- an assistant message carrying `tool_calls` must be answered by one `tool` message per
  call id;
- a `tool` message must answer a call that is still in the history.

A history that breaks either rule is refused with a 400 — and it keeps being refused,
because the history is carried from call to call. A **new** session starts from a short,
well-formed history and works. That is the difference between "the provider is broken"
and "this session's history is broken", and it is visible only if the *failing request*
is examined.

The harness can produce such a history: a compaction splits the window by token mass
rather than by call boundaries (`docs/context/compaction`), so the results of a batch can
be summarised away while the batch's own `tool_calls` message stays — or the other way
round. The record therefore names the call ids that lost their result.

## What is recorded

One line per failed attempt, scoped `provider`, carrying:

- the **status** and the provider's **reason**, extracted from the body: the JSON
  `error.message` of an OpenAI-compatible provider, Ollama's plain-string `error`, a
  bare text body, or the `error.metadata.raw` of a gateway. A body with no reason in it
  says so rather than inventing one.
- the **shape of the request**: how many messages it carried, how many of each role,
  how many bytes of content, how many tools were advertised, and whether it streamed —
  plus the last messages described by role, size and call id.
- the **pairing analysis**: how many calls the history made, how many results it
  carries, which call ids are **unanswered**, and which results are **orphans**.
- the **body itself**, read within a cap, so the operator reads the provider's own
  words rather than a summary of them.

The level follows the fate of the attempt: an attempt that will be retried is a `warn`
(something recovered from), the last one is an `error` (something that ended the work) —
the same rule the rest of the log follows (`docs/runtime/logging`).

## The log is not a second transcript

The conversation's **words are never copied** into the record. A request is described by
its *shape* — roles, counts, sizes, call ids — and the only quoted text is the
provider's own error body, because that is the diagnosis and not the conversation. The
session file already holds what was said (`docs/runtime/session-store`); the log holds
what the harness did.

## What is raised

The call raises an error that carries the record with it:

- the **status** is on the error, so a caller can tell an HTTP refusal from an abort
  (`app/turn-runner.js#isAbortFailure`);
- the **message** names the status and the provider's reason — the provider's own
  words, not ours — so the failure the reader sees says more than a bare number.

The error is raised **after** the record is written, so a failed attempt is never lost.

## Nothing here can cost the turn

- A body that cannot be read (a connection that died mid-body) is reported as
  unreadable; the record is still written.
- A history that is not an array is an empty history, and a message that is not an
  object is skipped: the analysis never throws.
- The body is read within a cap, so a huge error page cannot fill the log.
- The log write itself never throws (`utils/logger.js#logEvent`).

## The modules

The diagnosis is split along the same line as the rest of the harness:

- `api/provider-analysis.js` — the **pure half**: the reason extraction, the pairing
  analysis, the request shape and the record they build. No network, no log;
- `api/provider-diagnostics.js` — the **acting half**: reading the body off the wire,
  writing the record, and raising the error;
- `api/provider-response.js` — the two provider response shapes normalised into one.
  It was extracted from `api/ollama.js` to keep that module inside the line budget, and
  `normalizeUsage()` is re-exported from `api/ollama.js` so every existing import and
  every spec keeps pointing at the same symbol.

## See also

- Implementation: `api/provider-analysis.js`, `api/provider-diagnostics.js`,
  `api/provider-response.js`, `api/ollama.js`
- Proof: `tests/provider-diagnostics.test.js`, `tests/ollama-provider.test.js`
