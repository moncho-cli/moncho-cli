# Agent — the file hint (`hint_file`)

`read_file` returns bytes, and that is exactly what a patch or a diff needs. It is
also expensive: one generated file or one minified bundle can spend a large part of
the window on a single look. `hint_file` answers the other question — *what is in
here?* — with a deliberate sketch, so exploration costs a fraction of what a read
does.

The backlog entry:

> a new hint_file tool that is very similar to how read works, with the exception that
> all tabs and multiple continuous new lines are removed. long lines are truncated as
> well leaving a `...[N chars after]` so the model can hint file contents without
> risking super long lines congesting the context

## Two reading tools, one rule

| Need | Tool | What comes back |
| ---- | ---- | --------------- |
| the exact bytes (a patch, a diff, a line to match) | `read_file` | the page verbatim, `<file …>` |
| what a file is about | `hint_file` | the page *sketched*, `<hint …>` |

The two are never interchangeable, and the delimiter is what keeps them apart in a
transcript: a hint is introduced by `<hint …>` and a read by `<file …>`, and both
render through their own header (`app/tui-render.js#formatTranscript`).

## The lossy steps, in order

`utils/file-hint.js#hintFileText` is the whole rule, and it is pure: a string in, a
value out, no `fs`, no path. The steps run in this order because each one changes what
the next one measures.

1. **Newlines are normalised** (`\r\n` and `\r` become `\n`), so a Windows file does
   not double its blank-line count.
2. **Runs of blank lines collapse to one**, via
   `utils/file-hint.js#compressBlankLines`. Lines that hold only whitespace count as
   blank, and leading and trailing blank lines are dropped entirely: they carry no
   information and are the cheapest thing to lose.
3. **Tabs become spaces** on a fixed grid (`utils/file-hint.js#expandTabs`, eight
   columns by default), so an indented source file keeps its shape instead of spending
   a byte per tab stop — and a tab advances to the next multiple, so columns stay
   aligned rather than shifting with the text before them.
4. **Long lines are cut** with `utils/file-hint.js#truncateLine`, which keeps the head
   and appends `...[N chars after]`. The count is the *dropped* length, so the model
   learns that the line continues **and how much it is missing**; a bare `…` would
   hide the size of what it did not see. The cap counts the kept head only, so the
   budget means the same thing whatever was dropped.
5. **The whole hint is capped** by a character budget, applied last and on a line
   boundary: the kept body is followed by the same marker for the rest of the document.
   A hint that silently stopped would read like a short file, which is the one failure
   mode this tool must not have.

## Paging is exact, and so is the delimiter

A hint is lossy about the *content*, never about the *coordinates*.
`tools/hint_file.js` accepts the same `offset`/`limit` as `read_file` (a negative
`offset` counts from the end) and cuts the page on the characters asked for, so "hint
me the middle of this file" means the same region either way.

- The opening tag carries `path`, the line range (`from`/`to`, from
  `tools/read_file.js#lineNumberAtOffset`), `lines` (`kept/total` when the page is not
  the whole file), `chars` (what the hint returned) and `of` (what the page really
  held), plus `truncated=true` when any step dropped something.
- `chars` and `of` are the point: the model can see what the sketch cost and how much
  of the page it did **not** see, so the decision to call `read_file` is informed
  rather than guessed.
- `lineNumbers` is opt-in and off by default. A hint is meant to be compact, and
  `read_file` already offers exact numbered lines; a caller who wants numbered hints
  gets them numbered from the true first line of the page.

## Read-only, and a member of the read family

- `hint_file` only reads, so it is in `app/mode-policy.js#READ_ONLY_TOOLS`: Chat and
  Design may both use it, and it is advertised to the provider in both
  (`docs/interface/modes`).
- It belongs to the `read` family of `app/tool-palette.js#TOOL_FAMILIES`, so its call
  and its result are painted bright cyan like every other look and never like a write.

## Failure behaviour

The path resolves through the same sandbox as every other file tool
(`utils/path-safety.js#resolveProjectPath`), and a failure is the shared JSON error
shape (`status: "error"`, a stable `code`, `guidance`), never a throw:

- `INVALID_PATH` — the path is absolute, empty or escapes the project;
- `NOT_FOUND` — nothing exists at the path (a directory is not a file to sketch);
- `UNEXPECTED_ERROR` — anything else, with the message.

## See also

- Implementation: `utils/file-hint.js`, `tools/hint_file.js`, `app/tui-render.js`
- The exact-bytes counterpart: `tools/read_file.js`
- Sandbox: `utils/path-safety.js` (`docs/agent/file-safety`)
- Proof: `tests/hint-file.test.js`
