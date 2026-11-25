# Interface — a file write's diff, side by side with line numbers

> Original item (backlog 53): *the user conversation view should show the patch diff
> rendered in the popular left/right split to understand what was edited. new file
> creation can remain collapsed (by default) and expanded with a click. this widgets
> should show line numbers*

The transcript already reports **that** a file changed: a tool result is a collapsible
block quoting the tool's JSON (`docs/interface/json-display`). This capability adds the
row below it — **what** changed — because "Successfully applied 1 edit" is not something
a reader can check.

## The diff is host state, and that is the whole design

The bytes have to come from inside the writer: the text a `write_file` overwrote
(`tools/write_file.js`) and the `original` an `edit_file` applied against
(`tools/edit_file.js`). There is exactly one place they must **not** go, and it is the
obvious one:

`utils/tool-loader.js` hands the model the value `execute()` returns, and a `tool` chunk
carries it in the window. A diff attached there would be re-sent on **every following
call of the session** — hundreds of tokens of old and new file, billed for the rest of
the conversation, to draw one block on the screen.

So the pair travels through a host registry instead (`utils/write-journal.js`), the same
shape `utils/read-tracker.js` already uses for the staleness guard:

| Moment | What happens |
| ------ | ------------ |
| the write lands | `recordWriteCapture({ path, before, after, created })` files the pair under the path the result will report |
| the row is drawn | `app/tool-echo.js` takes the capture for `result.path` and calls `app/diff-view.js#writeDiffBlock` |
| `takeWriteCapture` returns | the entry is **dropped**, so a second draw of the same edit is impossible |

Four properties follow, and each is a decision rather than a consequence:

- **the tool result is byte-for-byte unchanged.** A case in `tests/diff-view.test.js`
  asserts it, and a probe confirmed that case is not vacuous — the naive shape (a `diff`
  field on the result) is what it catches.
- **one entry per path.** A file written twice in a turn shows the second diff, not a
  queue of stale ones.
- **nothing is persisted.** The journal is host state, so a resumed session shows no
  diffs for writes made before it. The view of a past write is in `agent/logs` and the
  tool result; a diff is a view.
- **an oversize pair keeps its shape and loses its bytes** (`DIFF_CAPTURE_MAX_CHARS`,
  2 M characters), so the echo still knows a write happened while nothing large is held.

A capture that was never recorded — a shell edit, a file changed outside these two
writers — answers `null`, and then **no block is added at all** rather than a misleading
one. The result row above it still reports the write.

## The pairing

`app/diff-view.js` is pure: it takes two texts and answers rows, so every rule below is
a unit test rather than a screenshot.

- **the anchor is a whole line.** `matchLines` computes a plain longest-common-subsequence
  over line arrays. A character-level diff is the wrong tool here: the reader compares
  *lines* of a file, and a one-token change diffed by character would paint most of the
  row as modified. The price is an `O(n·m)` table, which is why a pair sharing nothing is
  reported as a whole-file rewrite instead of paired (`writeDiffBlock`).
- **a modified line is one row, not two.** A removed line and an added line between the
  same two anchors pair up as `kind: 'changed'`, so a rewritten assignment reads as a
  modification rather than as a deletion followed by an insertion. Unmatched lines pair
  positionally while both sides have one; the leftovers are pure `removed` or `added`.
- **line numbers are per side.** A row carries `left`/`right` as `{number, text}` or
  `null`, so an insertion has no old number and a deletion has no new one. `gutterWidth`
  measures the widest number and is capped at `DIFF_MAX_GUTTER`.
- **`textLines` never invents a line.** `'one\n'` is one line, not two: a trailing newline
  ends the last line rather than starting an empty one.

## The layout, and the fallback that is a real answer

`diffLayout` measures the region and answers `split` or `sequential`:

- **`split`** is the reader's view — the old side, a marker column (` `, `-`, `+`, `~`),
  the new side, and two numbered gutters.
- **`sequential`** below `DIFF_MIN_SPLIT_WIDTH` (60 cells) is not a degradation: it emits
  the old side above the new one, which is what a diff looks like on a narrow terminal and
  the same information at half the width. A split that silently truncated a line would
  lose the one thing the block was opened for, so the choice is made by width and never by
  hoping the line was short.
- **a line is cut between grapheme clusters** (`fitSide`, the rule the queue row and the
  sticky bar already follow), ending with `…` so the reader knows what they are not
  seeing. Half an emoji in a diff is worse than a shorter line.
- **columns are padded, not the sides.** A side is padded only after the column width is
  known, because a side padded earlier would be padded twice.

## What a block opens with, and what it holds

`writeDiffBlock` answers four shapes. The **block itself always starts collapsed** — a
file write's diff is a tool result, and a tool result is one header line until the reader
clicks it (`docs/interface/transcript-blocks`) — so what varies is what the header says
and what the fold holds:

| Case | Block |
| ---- | ----- |
| a modified file | the diff inside, with `+n −m` in the header |
| a **created** file | "new file, N lines" in the header, the file's numbered lines inside |
| a **whole-file rewrite** | the count in the header, `(whole file)` beside it — every row was touched, so there is no shared anchor to read a diff against |
| nothing changed / no capture | **no block at all** |

## The route

`app/tool-echo.js` keeps its existing job — one header row and the payload — and adds one
step: after the result block, a successful result naming a `path` gets its diff block. The
line CLI is untouched by construction: it has no `logBlock`, so a headless run prints
neither the result block nor the diff, and the capture is left in the journal for the TUI.

The block is the same `logBlock` route every view-only announcement takes
(`docs/interface/tracking-block`), so it is **never a chunk and never a session file** —
presentation only.

## See also

- Implementation: `app/diff-view.js`, `utils/write-journal.js`, `app/tool-echo.js`,
  `tools/write_file.js`, `tools/edit_file.js`
- The block it becomes: `docs/interface/json-display`, `docs/interface/tracking-block`
- The registry shape it follows: `docs/agent/file-safety` (`utils/read-tracker.js`)
- Proof: `tests/diff-view.test.js`