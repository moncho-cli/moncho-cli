# Agent — web_search (finding the URLs worth fetching)

`web_fetch` answers *what does this URL say?*. `web_search` answers the question that comes
**before** it: *which URLs are worth fetching?* A model that only has `web_fetch` must
already know the address, which is exactly the knowledge a search supplies. So this is the
same door, one step wider — and the widening is bounded the same way.

## The provider is data, not code

`utils/web-search.js#SEARCH_PROVIDERS` maps a name to a record that says everything the
tool needs to know about one backend:

| field | what it decides |
| ----- | --------------- |
| `endpoint` | where the request goes |
| `params` | how the request is spelled (`engine`, `query`, `key`, `count`) |
| `resultsPath` | where the results live in the answer |
| `requiresKey` / `keyEnv` | whether a key is needed, and which variable holds it |

**`duckduckgo` is the default** (`DEFAULT_SEARCH_PROVIDER`), carried as the SearchApi.io
DuckDuckGo engine. Adding a provider is one entry in that table; the tool never learns a
second API, because `buildSearchUrl()` and `parseSearchResults()` read the record rather
than hard-coding a provider's field names.

The key is the user's, and **its absence is a refusal, not a crash**: a provider that needs
one answers `MISSING_API_KEY` naming the variable to set (`SEARCH_API_KEY_ENV`), so the
model can say what is wrong instead of reporting a 401 as a mystery. `WEB_SEARCH_ENDPOINT`
(`SEARCH_ENDPOINT_ENV`) points a provider at another endpoint — a mirror, a self-hosted
backend, or a stub — and is read **when a search runs**, not once at import, so a test can
point it at a hermetic server.

## The transport is `web_fetch`'s

A search is a **GET** of a JSON document, so it reuses the door `web_fetch` already opened
rather than opening a second one: `utils/web-fetch.js#fetchUrl` bounds the scheme, the
redirects, the downgrade and the time, and `readBounded` bounds the body
(`MAX_SEARCH_BODY_BYTES`). Nothing about "outside" is re-decided here; the search inherits
every bound the fetch established. It is a GET and nothing else — a search reads an index,
and a body-carrying method would be a write aimed at a stranger.

## The answer

`tools/web_search.js` answers in the **command document** shape the rest of the harness
already uses (`utils/command-output.js`): a YAML header, `---`, then the payload. The
payload is one numbered block per result — the title, the URL on its own line, and the
snippet — because a URL on its own line is what makes the payload greppable and what a
`web_fetch` call can be composed from (`formatResults`).

- **The parse is defensive on purpose.** A search API is a third party whose field names
  drift, and a list that silently came back empty because one key was renamed is worse than
  one that kept the fields it could read: a missing `link` falls back to `url`, a missing
  `snippet` to `description`, and an entry with neither a title nor a URL is dropped rather
  than rendered as a blank line (`parseSearchResults`).
- **The list is windowed from the top** (`windowBody`), and when it is cut the whole text
  goes into the capture store (`utils/capture-store.js#putCapture`) with a `capture: <id>`
  handle and its `range`. The model then pages or scans it with `read_capture`
  (`docs/agent/command-capture`) — one new tool, no second paging grammar.

## Success and failure are different questions

- A refusal **before** the request (an empty query, an unknown provider, a missing key) and
  a failure **during** it (a timeout, a refused connection) both answer the JSON envelope
  with a stable `code` and a `guidance` line, because a machine-readable reason is what the
  model acts on (`searchErrorDocument`).
- A provider that answered with **zero results** is a document, because the request worked
  and "nothing matched" is the news. A provider that answered with an `error` field is
  `PROVIDER_ERROR`, and a body that is not JSON is `INVALID_RESPONSE` with the status and a
  head of the body — a server's answer is never mistaken for a transport failure.

## It is a reader

`web_search` is one **GET** and nothing else: it cannot write, post, upload or delete, so it
changes nothing on disk. It therefore belongs to the read-only family
(`app/mode-policy.js#READ_ONLY_TOOLS`) and the read colour in the transcript
(`app/tool-palette.js#TOOL_FAMILIES`), and it is offered and allowed in every mode, `chat`
included — the same standing as `web_fetch`.

It is the second place where the privacy story grew a branch, and `PRIVACY.md` states it:
the agent's traffic is the provider **plus** any URL the agent itself chose to fetch or
search. It is visible in the transcript, because the call that caused it is printed there
like any other.

## See also

- Implementation: `utils/web-search.js`, `tools/web_search.js`
- The door it reuses, and the document shape: `docs/agent/web-fetch`,
  `docs/agent/command-sandbox`, `docs/agent/command-capture`
- Where a reader may run, and what leaves the machine: `docs/interface/modes`, `PRIVACY.md`
- Proof: `tests/web-search.test.js`
