# A page of a file, counted in lines

`read_file` and `hint_file` both page a file. They used to say so in two coordinate
systems at once: `offset` and `limit` counted **characters**, while the
`<file … from=… to=… lines=…>` delimiter reported **lines**. A page therefore began at a
character somewhere inside a line and was labelled as if that line were whole. Paging a
66-line file with `offset=1000, limit=300` answered `from=9 to=12`: a whole-line range
describing a 300-character slice that did not cover those lines (task-backlog item 63).

The damage is not cosmetic. The delimiter is the coordinate the model pages with, so it
could not compute its next `offset` from what it had been told, and the fragment of line 9
that arrived was labelled line 9 as though it were complete — which is precisely the
"paraphrase mistaken for the bytes" that `edit_file` refuses (`docs/agent/line-edits`).
Bad coordinates at the read are bad edits later.

## The rule

A line is the metric everything else in the harness already speaks: `grep` answers in
`path:line`, `edit_file` refuses on a search that does not match the bytes, the model's own
notes say "line 47". So the page counts lines and nothing in it is measured in characters.

- **`offset` is a 1-based line number.** The first line of a file is line 1.
- **A negative `offset` counts back from the last line**, so `-1` is the final line — not
  the bytes before the final newline.
- **`limit` is a number of lines**, and omitting it reads to the end of the file.
- **A bare read is capped.** Omitting `limit` used to read to the end, so one call on a
  generated bundle or a data file could spend the window by itself and force a
  compaction. The page now stops at `READ_MAX_LINES` (2000 by default) and the tag says
  so with `truncated=true` beside `lines=<returned>/<total>`, so the model pages with
  `offset` instead of guessing at the size. An explicit `limit` is honoured but **never
  past the cap** — the cap is a ceiling, not a default — and `READ_MAX_LINES=off` (or
  `0` / `none` / `unlimited`) removes it so the old behaviour is one variable away.
  `resolveReadLimit()` (`tools/read_file.js`) is the one rule, and `capped` is what the
  tag reports: a page stopped by the caller's own `limit` is not marked, because it is
  not the cap that stopped it.
- **The page is whole lines.** No line is ever cut, so `from`, `to` and the numbered body
  cannot disagree.
- **A page that starts past the end is empty and reports no range.** It is not clamped
  onto a neighbouring region: a fabricated `from` is exactly what a reader would trust and
  be wrong about. The size (`lines=0/N`) is still reported, so the caller learns the bounds
  it overshot.
- **Line counting is the split-on-newline convention** every read has always used, so a
  trailing newline opens one final empty line and `"a\n"` is two lines.

`read_file` and `hint_file` share this arithmetic through
`utils/line-page.js#resolveLinePage`, so the two tools cannot drift apart on what "lines 4
to 6" means: the hint spec's promise that a hint pages "the way `read_file` does" is now a
property of shared code rather than two copies of the same formula.

`lineNumbers: true` numbers the page from the file's own lines, never from the page's first
line, so a `from=` attribute and the printed numbers are the same numbers.

## The cap is a ceiling, not a page size

Two things must not be confused, and the tag keeps them apart:

- the **cap** (`READ_MAX_LINES`) is what stops a read the caller did not bound. It is
  reported as `truncated=true`, and the page it returns is a real page — `from=1 to=2000`
  with `lines=2000/12000` — so the next `offset` is arithmetic, not a guess;
- an **explicit `limit`** is the caller's own page. It is honoured exactly when it is
  under the cap and clamped to the cap when it is over, and a page it stopped is *not*
  marked `truncated`, because the cap had nothing to do with it.

The cap is deliberately far above any file this project's own size budget allows (600
lines, ceiling 900), so a legitimate read is never capped and only a pathological one is.
The guidance the model gets is the one the backlog asked for: prefer `grep` first, and
read only what it points at.

## One consequence worth naming

`read_file` once exported `lineNumberAtOffset`, which mapped a character offset to a line.
That helper existed to translate between the two coordinate systems; with one coordinate
system left there is nothing to translate, and it is gone. Anything that needed it needed
the page instead.