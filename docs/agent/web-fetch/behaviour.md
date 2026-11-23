# Agent — web_fetch (retrieving a URL, bounded in every direction)

Every other tool in this harness answers a question about the **project tree**. `web_fetch`
answers one about the network: *what does this URL say?* That single difference is the whole
design, because "outside" is the one direction where the harness cannot see what it is
touching — so the door is made narrow, and everything about it is a bound.

## The door

`utils/web-fetch.js` is where a URL becomes answerable. Four bounds, and each one is a
decision rather than a default:

- **the scheme.** `http` and `https` only (`ALLOWED_PROTOCOLS`). `file:`, `data:` and the
  rest are a different capability wearing a URL's clothes, and the agent already reads local
  files with the tools that are *allowed* to. `validateFetchUrl()` refuses the others as
  `UNSUPPORTED_PROTOCOL`, and a bare host as `INVALID_URL` with the fix in the message
  ("include the scheme") — the mistake a caller actually makes.
- **the size.** The body is read **streaming** (`readBounded()`) and cut at `maxBytes`
  (default `DEFAULT_MAX_BODY_BYTES`), and the reader is cancelled the moment the cap is
  reached, so a hostile or merely huge response costs a bounded amount of memory and of
  context. A cut body is `truncated: true` with `total_bytes` beside `bytes` — never a
  silent shortening.
- **the redirects.** At most `DEFAULT_MAX_REDIRECTS` hops, followed **manually** so two
  rules hold: a loop is an error (`TOO_MANY_REDIRECTS`) rather than a hang, and `https` is
  never downgraded mid-chain (`REDIRECT_DOWNGRADE`). "The page moved" is not permission to
  send the request in the clear.
- **the time.** One `AbortSignal.timeout` (`timeoutSignal()`) covers the whole exchange,
  because a host that accepts a connection and never answers is exactly the case a timeout
  exists for.

The request is always a **GET**: a fetch reads a resource, and a body-carrying method would
be a write aimed at a stranger. The `accept` list is fixed — the user's key, the conversation
and every local path stay out of the request — while the `User-Agent` is the one header the
user may name: `MONCHO_USER_AGENT` (`config/constants.js#USER_AGENT`) is presented when set,
and `moncho-cli` (`FETCH_USER_AGENT_DEFAULT`) otherwise, because a client that names itself
nothing is refused by a fair number of hosts (`utils/web-fetch.js#fetchHeaders`). The same
variable names the program to the provider (`docs/runtime/provider-calls`).

## The body

`tools/web_fetch.js` answers in the **command document** shape the rest of the harness
already uses (`utils/command-output.js`): a YAML header, `---`, then the payload. Learning a
second result format for one tool would cost the model more than the tool is worth.

- **HTML is reduced to text** by `utils/html-text.js`. Raw elements (`script`, `style`,
  `noscript`, `template`, `svg`, `head`, `title`) are dropped entirely *before* entities are
  decoded, so a script containing `&lt;/script&gt;` cannot smuggle itself back in as markup.
  Block elements end a paragraph (`breakFor()`), list and table members end a line, and an
  inline tag introduces **nothing** — `a<b>bold</b>.` is `abold.`, not `a bold .`.
  `decodeEntity()` handles the named table, `&#38;` and `&#x26;`, and leaves an unknown or
  malformed reference exactly as written: a page showing `&foo;` meant to show `&foo;`.
- **JSON and plain text pass through** as they arrived, because an API's answer is already
  text (`bodyText()`, `isHtmlType()`).
- **The charset** is the response's `content-type`, else the document's own `<meta>`
  (`charsetFromBody()`), else UTF-8. An unknown label falls back to UTF-8 and says so in the
  header's `note` — mangled text beats no text.
- **The text is windowed from the top** (`windowBody()`): a document's meaning starts at its
  opening, which is the one place this differs from a command's default tail, where a build's
  verdict is at the end. The header carries `lines`, `shown`, `mode` and `truncated`, so a
  clipped body is never mistaken for a complete one.

## The capture, and no second paging grammar

A long body is not lost. When **either** bound cut it — the window, or the download — the
whole text goes into the capture store (`utils/capture-store.js#putCapture`) and the header
carries `capture: <id>` with its `range`. The model then pages or scans it with
`read_capture` (`docs/agent/command-capture`), which it already knows.

The download case is the subtle one and is deliberate: a cut body can be a **single long
line**, so nothing was windowed and `mode` is `all` — yet the rest of the page is precisely
what a caller may still need. Writing the capture on the window alone would lose it.

## Success and failure are different questions

- A refusal **before** the request (a bad URL, a wrong scheme) and a failure **during** it (a
  timeout, a refused connection, a redirect loop) both answer the JSON envelope with a stable
  `code` and a `guidance` line, because a machine-readable reason is what the model acts on.
- A **server answer is a document**, 404 and 500 included: the request worked, and the status
  is the news — the same rule that makes `run_bash` report a failing command structurally
  instead of hiding it. `http_status` says what the server said.

## It is a reader

`web_fetch` is one **GET** and nothing else: it cannot write, post, upload or delete, so it
changes nothing on disk. It therefore belongs to the read-only family
(`app/mode-policy.js#READ_ONLY_TOOLS`) and the read colour in the transcript
(`app/tool-palette.js#TOOL_FAMILIES`), and it is offered and allowed in every mode, `chat`
included — the same standing as `read_file`.

This is the one place where the privacy story grew a branch, and `PRIVACY.md` states it: the
agent's traffic is the provider **plus** any URL the agent itself chose to fetch. It is
visible in the transcript, because the call that caused it is printed there like any other.

## See also

- Implementation: `utils/web-fetch.js`, `utils/html-text.js`, `tools/web_fetch.js`
- The document shape and the capture it hands out: `docs/agent/command-sandbox`,
  `docs/agent/command-capture`
- Where a reader may run, and what leaves the machine: `docs/interface/modes`, `PRIVACY.md`
- Proof: `tests/web-fetch.test.js`
