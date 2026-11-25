# Agent — repairing a formatting-only edit miss

A model composes a `search` from the bytes it read, and often the *text* is right while the
*bytes* are wrong: the sketch it came from expanded a tab, its own earlier `replace` used a
different indent, a CRLF file was quoted with LF. `utils/edit-miss.js#diagnoseMiss` already
names that difference, so refusing costs the model a round for an answer the engine could
have applied itself.

`utils/edit-repair.js#repairSearch` applies exactly the repair the diagnosis names, **once**,
before the miss becomes a refusal (backlog item 83).

## The three rules that make it safe

The repair is a rewrite of the model's own search text, so what it may touch is the whole
safety argument:

1. **Only line-edge whitespace and line endings are normalised.** A line matches when its
   `trim()` equals the search line's `trim()`, so the interior of a line is compared byte for
   byte. `const  a` and `const a` are different code, not different formatting, and the
   interior of a string literal is code for the same reason. A search that differs there is
   never repaired — it stays `SEARCH_NOT_FOUND`.
2. **One place, or nothing.** `repairSearch` returns `null` when the block matches in more
   than one place, because choosing "probably the first one" is how an edit lands in the wrong
   function. `whitespaceCandidates` gives the refusal those places, so the model can quote
   more context and make it exactly one.
3. **The replacement is never re-indented.** The model wrote `replace` for the indentation it
   believed in; shifting it is a guess about a block that may contain a template literal. The
   repair fixes the *search*, and the replacement lands verbatim.

There is a fourth rule that is about honesty rather than safety: a search that already matches
literally is not a repair, so an ordinary edit never claims one.

## What the caller sees

`repairSearch` answers `{ search, rule, note, line, actualIndent, expectedIndent }` — the
search text rewritten in the file's own bytes, the rule that explains the difference, and a
sentence naming it (`the search was indented 4 space(s) but line 2 has 2; the search now
matches the file`). `classifyRepair` picks the rule from what actually differed:
`line-endings`, `indentation`, `trailing-whitespace`, or `whitespace` when both edges did.

`applyOne` (`utils/edit_lib.js`) tries the repair only when the literal match found nothing,
then matches again against the file's own text — and advances the slice by **that** text's
length, not the search the model wrote. Getting this wrong is a silent corruption: the
shorter typed search would leave a tail of the file's bytes behind. The result carries
`repaired: { rule, note, line }`, `applyEditsToText` copies it into the edit's entry of the
batch report, and `tools/edit_file.js` answers with a top-level `repaired` array plus a
sentence in `message`, so a success that needed one says so instead of reading as if the
search had matched.

## The engine's line-ending domain

`applyEditsToText` already folds a CRLF file to LF before matching and restores the endings on
the way out (`docs/agent/line-edits`), so `repairSearch` is called in the **LF domain** and
returns its answer in it. That leaves the line-ending rule one job: a search that still
*carries* CR or CRLF while the text it means is LF, which is what a model quote copied out of
a Windows tool looks like.

## A refusal keeps everything it had

An unmatched search is refused exactly as before — `candidates`, `hint`, `source`, `retry` and
`guidance` — with one addition: when the text matches on line-edge whitespace alone in several
places, the refusal carries `whitespaceMatches: [{ line }]` and a `hint` saying that repairing
it would be a guess. So the failure mode the repair refuses to guess at is still a
one-retry answer, not a dead end.

## See also

- Implementation: `utils/edit-repair.js`, `utils/edit_lib.js#applyOne`,
  `tools/edit_file.js`
- The engine and the diagnostics it builds on: `docs/agent/line-edits`
- Proof: `tests/edit-repair.test.js` (the pure rules), `tests/edit-repair-tool.test.js`
  (the repair reaching the file)