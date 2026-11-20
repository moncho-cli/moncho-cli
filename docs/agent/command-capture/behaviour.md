# Agent — command captures (the full output behind a truncated document)

A command's output can be enormous — a test suite says more in five thousand lines than
any window should hold — and the document `docs/agent/command-sandbox` describes answers
that by *windowing* it: a header, a `---`, and the part that was asked for. That leaves
one question open, and this spec is the answer to it: **where did the rest go?**

It goes into memory, behind a handle. A capture is the file-like half of a command
result: the model reads a truncated document, sees `capture: 2` and the counts, and then
**pages or scans the whole stream** with the tools it already knows — `offset`/`limit` for
a window, `pattern` for the lines that matter.

Three properties are deliberate, and each one is a decision rather than an accident:

- **nothing touches disk.** Command output is attacker-influenced text, and a shell is in
  the allow-list: a file holding a captured stream would be a path a later command could
  read *and run*. A capture is a string in a `Map` and never a file.
- **a capture is short-lived.** It expires as soon as the turn moves on to a batch that
  does not read it, so the memory it holds is bounded by one action rather than by the
  session. Inspecting a capture is the model's *next* action, by construction.
- **the store is bounded anyway.** At most `DEFAULT_MAX_CAPTURES` captures and
  `DEFAULT_MAX_CAPTURE_BYTES` in total, oldest dropped first, so a long session cannot
  grow without limit even if nothing expires.

## The store

`utils/capture-store.js` is the whole registry, and it is pure bookkeeping: no `fs`, no
child process, no terminal, so the bounds and the expiry are unit tested on plain strings.

- `putCapture()` stores one stream and returns its entry; the **handle is monotonic and
  never reused** (`nextId`), so a stale `capture: 2` in an old transcript fails instead of
  silently addressing a newer capture. That is what makes `CAPTURE_EXPIRED` an honest
  answer rather than a coincidence.
- Eviction runs **inside** the put, so a caller can never leave the store oversized. The
  entry just stored is the newest, so eviction can never take it.
- `expireCaptures({ keep })` is the lifetime rule: keep exactly the handles named, drop
  every other capture. `capturesRequestedBy(calls)` is its input — the handles a batch of
  tool calls asked to read, from either accepted call shape, and nothing from a call whose
  arguments could not be parsed (an unparseable call reads nothing, so it keeps nothing
  alive).
- `captureStats()` and `captureIds()` exist for diagnostics and for the tests.

## The selection

`utils/capture-window.js` is the file-like half, and it mirrors the paging `read_file`
already offers so the model learns one idea rather than two:

- a **page** is `offset`/`limit`, with a **negative offset counting from the end** ("the
  last 50 lines" is one call, not arithmetic the caller has to do). Lines come back
  **numbered** (`   12  the line`), so a page can be cited in a later call. `limit`
  defaults to `DEFAULT_CAPTURE_PAGE` and is capped at `MAX_CAPTURE_PAGE`: one page cannot
  refill the window the windowing just emptied.
- a **scan** is `pattern` (a regular expression, or literal text with `fixedStrings`),
  returning only the matching lines, numbered, capped at `DEFAULT_MAX_MATCHES`. This is
  the operation that makes a test run usable: `pattern: 'FAIL|✗|Error'` answers *what
  broke* without reading five thousand lines. A `pattern` wins over `offset`/`limit`,
  because scanning is what a caller asking for one really wants.
- a nonsense page (`limit: 0`, a count above the cap) is `INVALID_RANGE`, and a broken
  regular expression is `INVALID_PATTERN`. Both are refused with the code, never a silent
  empty page.

## The tool

`tools/read_capture.js` exposes the two selections as one tool, and it is a **reader**: it
names a handle, never a path, so it can change nothing on disk and belongs to the
read-only family (`app/mode-policy.js#READ_ONLY_TOOLS`, `app/tool-palette.js#TOOL_FAMILIES`).

- It answers in the same document shape as a command (`renderYamlHeader`, `---`, body):
  `capture`, `command`, `lines`, `shown`, `truncated`, `mode`, `from`, `to`, the `matches`
  of a scan and the request that produced the page — so a page is as readable as the
  document that pointed at it.
- An unknown or expired handle is `CAPTURE_EXPIRED`, with the guidance that names the way
  out (re-run the command with a window, or read the capture in the same action as the
  call that produced it). It is **never** an empty page: "the bytes are gone" and "the
  bytes are empty" are different answers.

## Expiry has exactly one home

`app/tool-batch.js#handleToolBatch` is the only place that knows a batch has ended, so the
lifetime rule lives there and nowhere else:

- the captures that existed **before** the batch and that the batch did not ask to read are
  dropped when it finishes;
- a capture **taken during** the batch is kept, because reading it is the next batch's
  business — which is exactly what makes "run the command, then inspect what it said"
  work without a second mechanism.

A session that resumes, an interrupt, a process that dies: all of them lose the captures,
and that is the safe direction. A handle that no longer resolves answers `CAPTURE_EXPIRED`
instead of pretending.

## What this deliberately does not do

There is **no disk spill**. The escape hatch for a stream that must outlive a turn is
already in the harness and needs no new code: run the command with `head`/`tail` for the
part that matters, or write it where it belongs with the tools that write files. A capture
is for the question "what did that output say?", and one action is the whole lifetime that
question needs.

## See also

- Implementation: `utils/capture-store.js`, `utils/capture-window.js`,
  `tools/read_capture.js`, `app/tool-batch.js`, `app/mode-policy.js`,
  `app/tool-palette.js`
- The document that hands out a handle: `docs/agent/command-sandbox`
- The paging `read_file` already offers, which the selection mirrors:
  `docs/agent/tool-call-contract`
- The batch whose end expires a capture: `docs/agent/tool-multicall`
- Proof: `tests/command-capture.test.js`
