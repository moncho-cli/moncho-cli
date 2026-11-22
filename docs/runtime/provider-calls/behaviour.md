# Runtime — provider calls

All model traffic goes through one function so the provider, the system prompt and
the response shape are decided in a single place. This spec fixes that contract; the
implementation is linked below.

## The call

- `callOllama(messages, tools, isStreaming, signal, options)` is the only model
  entry point. It builds the request body from the configured model, attaches the
  tool schema block when tools are present, and posts to the configured base URL
  with a bearer token when an API key is set.
- The agent **system prompt is injected by default**: `config/prompt.md` is read once and
  cached, then prepended as the first `system` message. Internal calls pass
  `{ systemPrompt: false }` so they do not answer as the agent — the context
  summariser is the caller that relies on this.
- The agent can converse in the user's language while tasks, documentation, comments
  and source code follow the project's language and conventions. Optional
  `PROJECT_LANGUAGE` supplies a preference for artifacts; blank or unset adds no
  preference, and repository rules and conventions still take precedence. The
  preference is part of the cached agent prompt, not internal calls.
- Streaming is opt-in via the flag; the Ollama-only `think` flag is sent only when
  the base URL looks like Ollama, so an OpenAI-compatible endpoint never receives
  an unknown field.
- The **sampling temperature is opt-in**: `MODEL_TEMPERATURE`
  (`config/constants.js#MODEL_TEMPERATURE`) is sent as `temperature` only when the user
  configured a usable value, in the conventional `0`–`2` range. With the variable unset
  the key is **absent** from the body, so the provider's own default applies exactly as
  it did before the knob existed. A value outside the range, or one that does not parse,
  reads as **unset** rather than being sent: a typo must never silently change how the
  model answers.

## Responses

- Responses from both shapes are **normalised** to
  `{ message: { content, tool_calls } }`: the Ollama native shape
  (`{ message }`) and the OpenAI-compatible shape (`{ choices[0].message }`). A
  payload with neither still yields a message with empty content, so the caller
  always has something to read.
- Tool calls are normalised too: missing ids are synthesised, the type defaults to
  `function`, and `arguments` is always a JSON string (an object is stringified).
  This is what lets the conversation store one uniform assistant chunk.

## A non-200 is recorded before it is raised

- Every non-200 answer — streaming or not — is **recorded before the error is raised**
  (`api/provider-diagnostics.js`): the status, the provider's own reason, the shape of
  the request and the tool-call pairing of the history it carried. The error the call
  raises carries the status and the provider's reason, so a reader sees more than a
  number. The whole contract is `docs/runtime/provider-diagnostics`.
- The record is the way to tell "the provider is broken" from "this session's history is
  broken": a history whose `tool` messages no longer answer the calls above them is
  refused with a 400 and keeps being refused, while a new session works.

## Retries and cancellation

- A transport/HTTP failure is retried up to 3 times with a delay between attempts —
  except when the abort signal is already aborted, which propagates immediately.
  Retrying a cancelled task would ignore the user's ESC / Ctrl+C and stall the
  prompt.
- The `AbortSignal` is passed to `fetch`, so a cancelled task aborts the in-flight
  request rather than waiting for it.
- A retried attempt is reported through the injected `onRetry({ attempt, maxRetries,
  delayMs, error })` hook instead of being written to the console, because it is
  *news* and not history: the host shows it in the transient notice overlay, where it
  disappears on its own (`docs/interface/notice-overlay`). Without a hook the
  previous `console.warn` line is kept, so the provider stays usable on its own, and
  a hook that throws is swallowed — a broken notice must never cost the user a retry.
- Streaming decodes SSE/data lines, ignores non-JSON keep-alive framing, writes
  thinking text to the capture file instead of the transcript, and returns the full
  response text.
- **The partial line is kept between reads** (`api/stream-reader.js`). A streaming
  response arrives as bytes, and one read routinely cuts a JSON payload in half; splitting
  each read on its own threw the incomplete line away and left the next read's tail
  unparseable, so the deltas inside both fragments were silently dropped. That is the
  reported "the prose is missing space characters, usually at the end" — a space is a
  delta, and a delta split across a read boundary is a delta lost. `createLineSplitter()`
  owns the remainder, `readStream()` appends each read to it and releases only lines that
  really ended, and a final flush releases a last line with no trailing newline. The
  decoder runs with `stream: true` for the same reason at the byte level: a multi-byte
  character is kept whole across a read boundary too.
- `parseStreamLine()` treats `thinking` as a **flag**, not text: a delta marked with it
  carries reasoning in its `content`, and that text goes to the capture file, never to the
  prose. Framing, keep-alives and an unparseable payload answer `null` — a streaming
  response carries all of them and none is a failure.
- **The thinking capture lives in the state tree, not at the project root.** Its path
  is `THINKING_FILE` (`config/constants.js`), defaulting to `agent/thinking.md` — next
  to the sessions and the log — and it is resolved through
  `utils/path-safety.js#resolveProjectPath`, the sandbox every file tool uses, so an
  absolute or escaping value is refused instead of writing outside the workspace. A
  path that cannot be resolved turns the capture **off** (logged as a warning) rather
  than failing the call: losing a reasoning trace must never cost the user their turn.
  Before this, the path was derived from `api/ollama.js`'s own location and landed at
  the workspace root, where a container run leaked it into the checkout.

## Provider identity

- `detectProvider` maps the base URL to a provider name (openrouter, openai,
  anthropic, gemini, ollama, else the hostname or `unknown`) and
  `describeModel()` returns the provider, model, base URL and the
  `provider · model` label the UI shows. Both are derived from the environment, so
  switching providers needs no code change.

## See also

- Implementation: `api/ollama.js`, `api/stream-reader.js`, `config/constants.js`,
  `api/provider-response.js`
- Proof: `tests/ollama-provider.test.js`, `tests/stream-reader.test.js`,
  `tests/model-temperature.test.js`, `tests/provider-diagnostics.test.js`
