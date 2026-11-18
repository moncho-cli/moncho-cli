# Context — resolving the window size

The size that matters is the **real** context length of the model the provider
serves. When the provider exposes it, the harness reads it; when the user also set
a config override, the override is the working budget but the UI must show both.
This spec fixes the resolution order, the provider shapes, and the label; the
implementation is linked below.

## Resolution order

1. **A config override** (`CONTEXT_MAX_LENGTH`) wins as the working budget — the
   user explicitly asked for this size.
2. Otherwise the **real total reported by the provider**.
3. Otherwise `DEFAULT_CONTEXT_MAX_LENGTH` (128000).

The provider total is always reported separately as `realTokens`, regardless of
which budget won, so the UI can render both.

## Provider lookup

- The metadata endpoint is derived from the configured base URL, so switching
  providers needs no code change:
  - Ollama (`:11434`, `/api/chat`) → `POST <base>/api/show` with `{ model }`;
  - OpenAI-compatible → `GET <base>/models`, query string stripped.
- Response parsing is tolerant and shape-based, not provider-hardcoded:
  - OpenRouter/OpenAI: `data[]`/`models[]` entries matched by `id`/`name`/`model`
    against the configured model, then `context_length`/`contextLength`, then
    `top_provider.context_length`.
  - Ollama `/api/show`: `model_info["<arch>.context_length"]`, or `num_ctx` parsed
    out of the newline string in `parameters`.
  - A bare `context_length`/`contextLength` on the payload as a last resort.
- Any value that is not a positive integer is ignored (`null`).

## Robustness

- The lookup is **best effort and never blocks startup**: a timeout (default 4s),
  a non-ok response, a thrown fetch or a missing fetch implementation all degrade
  to "no provider total" and let the override or default decide.
- `resolveContextSize` takes its `fetchImpl`, base URL, model, key and timeout as
  arguments, so it performs no network call at import time and is fully testable
  with a stub.

## The label

`formatContextLimit` renders the limit so the difference is visible at a glance:

| Situation | Label |
| ------------------------- | -------------------------------------------------- |
| Override differs from real | `128.0k configured (total: 1.0M)` |
| Override, no provider total | `128.0k configured` |
| Real total from the API | `1.0M (from API)` |
| Default fallback | `128.0k` |

The `ContextWindow.usage()` string appends that label in brackets when an override
differs from the real total, so the status bar shows both numbers.

## See also

- Implementation: `utils/context-size.js`, `config/constants.js`,
  `app/context-window.js`, `main.js`
- Proof: `tests/context-size.test.js`
