# Interface — markdown tables in the transcript

A model writes tables often — a comparison, a summary, a list of files — and a
transcript that prints them verbatim shows **ragged pipes**: every cell keeps its own
width, so the columns drift the moment one cell is longer than its neighbour. This
spec fixes how a table is recognised and re-laid; the implementation is linked below.

The source is the backlog item:

> make sure markdown is properly formatted (tables look misaligned for example)

## What is a table

`app/markdown-table.js` recognises a table the way markdown defines one:

- a **header row** — a line carrying a `|` cell separator;
- immediately followed by a **delimiter row** — `| --- | :--: |`, whose cells are all
  dashes with an optional colon on either side;
- with the **same number of cells** as the header, and at least **two** of them;
- followed by zero or more **body rows**: every following line that still carries a `|`
  and is not itself a delimiter row.

Anything else is prose, and stays prose — deliberately:

- a line with a `|` in it but no delimiter row under it (`run cat a | grep b`) is a
  sentence, and a pipeline in it must survive untouched;
- a one-cell "table" is a paragraph with a pipe in it, not a table;
- a header and a delimiter of different widths are not a table either (the row would
  have no defined shape to align to).

## How a column is laid out

- **Widths are measured in display cells**, with `app/tagged-text.js`: a wide glyph (a
  CJK character, an emoji) is charged the two columns a terminal paints it in, and a
  combining mark none — the same unit the queue rows and the band padding use.
- **Inline markup costs no column.** `formatTranscript()` applies `**bold**` and
  `` `code` `` to each cell *before* the widths are measured, so `**bold**` is four
  cells exactly like the word `bold`, and the column does not grow by the markers.
- **The delimiter row carries the alignment**: `:---` left, `---:` right, `:-:` center.
  A cell is padded on the side its column names, so a numeric column reads right-aligned
  and a label column left-aligned.
- **Cells are padded to their column**, never truncated: the widest cell of a column
  sets its width, and a short cell is padded so the separators land on one column.
- A row **missing a trailing cell** still gets its separator, so the grid stays square.

## How it renders

| piece | rendered as |
| ---------------- | ------------------------------------------- |
| outer separator | the transcript frame's own cyan `│` |
| header cells | bold, inside their column |
| vertical rule | a cyan row of `─` segments joined by `┼` |
| body cells | padded to their column and alignment |

The rendered row opens with a blessed-tagged `│`, so the palette
(`app/theme.js#isTagged`) leaves it **untouched**, exactly like a fence or a tool
delimiter: the table keeps the markdown renderer's colours rather than gaining the
row colour of prose. The delimiter row is **not** painted as written — the rule *is*
the delimiter, so the raw `| --- |` never reaches the screen.

## Presentation only

The table is re-laid for **display only**: it is the output of `formatTranscript()`,
which the line CLI never calls (`docs/interface/line-cli`), and nothing here touches a
context chunk or a session file.

## See also

- Implementation: `app/markdown-table.js`, `app/tagged-text.js`, `app/tui-render.js`
- Spec of the renderer it plugs into: `docs/interface/tui`
- Spec of the row colours it composes with: `docs/interface/conversation-colors`
- Proof: `tests/markdown-table.test.js`
