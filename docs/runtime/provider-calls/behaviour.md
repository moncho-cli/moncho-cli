# Runtime — provider calls

All model traffic goes through one function so the provider, the system prompt and
the response shape are decided in a single place. This spec fixes that contract; the
implementation is linked below.

## The call

- `callOllama(messages, tools, isStreaming, signal, options)` is the only model
  entry point. It builds the request body from the configured model, attaches the
  tool schema block when tools are present, and posts to the configured base URL
  with a bearer token when an API key is set.
- The agent **system prompt is injected by default**: `prompt.md` is read once and
  cached, then prepended as the first `system` message. Internal calls pass
  `{ systemPrompt: false }` so they do not answer as the agent — the context
  summariser is the caller that relies on this.
- Streaming is opt-in via the flag; the Ollama-only `think` flag is sent only when
  the base URL looks like Ollama, so an OpenAI-compatible endpoint never receives
  an unknown field.

## Responses

- Responses from both shapes are **normalised** to
  `{ message: { content, tool_calls } }`: the Ollama native shape
  (`{ message }`) and the OpenAI-compatible shape (`{ choices[0].message }`). A
  payload with neither still yields a message with empty content, so the caller
  always has something to read.
- Tool calls are normalised too: missing ids are synthesised, the type defaults to
  `function`, and `arguments` is always a JSON string (an object is stringified).
  This is what lets the conversation store one uniform assistant chunk.

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
  thinking text to `thinking.md` instead of the transcript, and returns the full
  response text.

## Provider identity

- `detectProvider` maps the base URL to a provider name (openrouter, openai,
  anthropic, gemini, ollama, else the hostname or `unknown`) and
  `describeModel()` returns the provider, model, base URL and the
  `provider · model` label the UI shows. Both are derived from the environment, so
  switching providers needs no code change.

## See also

- Implementation: `api/ollama.js`, `config/constants.js`
- Proof: `tests/ollama-provider.test.js`
