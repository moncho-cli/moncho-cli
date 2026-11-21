# Interface — selecting text in the conversation and saving it on release

A terminal keeps its own selection: the terminal paints it, the terminal holds it, and
the process is never told it happened. So Moncho makes the selection itself — in the
conversation's own model — and saves the result to a **file in the workspace**, which is
the one medium that needs neither a display server nor the terminal's cooperation. A
container has no clipboard to reach, and an escape sequence is a hope; a file is a fact.

This spec fixes what a drag means, what a plain click still means, where the text is
written, and what the reader is told — including the one neo-blessed behaviour that
decides the whole design. The implementation is linked at the bottom.

## The gesture

Four edges, and the one that makes the feature work is the one neo-blessed gets wrong.

**A drag is reported as repeated `mousedown`, never as `mousemove`.** blessed recognises
motion only from the *no-button* report codes
(`node_modules/neo-blessed/lib/program.js#_bindMouse` — the test is literally
`b === 35 || b === 39 || b === 51 || b === 43`). A drag carries the button bit: 32 for the
left button in the SGR encoding a modern terminal sends, which is 35 − 4 and therefore
fails that test, so it falls through to `action = 'mousedown'` **with the new
coordinates**. Every step of a drag arrives as another press.

That single fact is the whole bug this feature had. A machine that treated every
`mousedown` as the start of a gesture re-anchored at every step, so a drag ended with a
zero-width range: it copied nothing and said nothing. Holding **Shift** appeared to fix it
because Shift adds 4 to the code and 39 *is* in blessed's motion list — the workaround was
the symptom, and it is worth stating because a report of "I have to hold Shift" points
straight at the decoder and nowhere else.

| Event | What it does |
| ------------ | ------------------------------------------------------------ |
| `mousedown` | the **first** press opens a gesture at the cell under the cursor; every later one is a drag step that **extends** it. The band is repainted whenever the point moved |
| `mousemove` | in practice a **hover** — blessed only reports the no-button case this way. It extends a live gesture and is ignored when no button is held, so a bare pointer crossing the conversation selects nothing |
| `mouseup` | **finishes** the gesture, with the release point taken from the event itself |
| `click` | finishes it too — blessed emits it *before* `mouseup` for the same report, and an already-finished gesture answers null, so a terminal that sends both copies exactly once and the click still falls through |

The rule that keeps the existing behaviour intact is the last row's second half: a gesture
that never moved is **not** a selection. `finish()` answers null, the pane calls
`clickAt()`, and a plain click expands or collapses a tool result exactly as before. A
gesture that did move copies and consumes the click, so dragging across a collapsed block
copies its header instead of toggling it.

Whichever edge finishes it, the selection is **cleared** at that moment and the band is
repainted away, so a release never leaves a stale highlight on screen.

One arithmetic detail belongs here because it is easy to get wrong when reading a terminal
report: **the coordinates on the wire are 1-based** and blessed subtracts one
(`program.js#_bindMouse`: `if (this.zero) key.x--, key.y--`). A report for the screen cell
`(x, y)` carries `x + 1` and `y + 1`.

### Leaving the pane

A gesture is not owned by the region it starts in. blessed hit-tests every report against
every clickable element and delivers the action **only to the one under the pointer**
(`screen.js#_listenMouse`: the loop `break`s at the first hit), so a reader who drags off
the conversation and releases over the status bar or the input box has that release
answered by *that* region — the transcript never hears it. The reported symptom is exact: a
selection **stuck as a held press** until the button is pressed again somewhere inside.

The screen re-emits every report (`self.emit(data.action, data)`, same function) whether or
not an element claimed it, so the rule is:

- the **release is bound on the screen**, and it finishes the gesture wherever the button
  came up;
- a **drag step that has left the pane is taken on the screen too, but only while a gesture
  is already live**. The screen sees *every* press, including the ones aimed at the input
  box, and only a live gesture may answer one — otherwise clicking the input box would
  start selecting the conversation.

A point outside the drawn content is **clamped into it**, so the gesture stays meaningful:
dragging past the last line copies to the end of it, and past the right edge copies to the
end of the row. The clamp is against what is *drawn* — the rows and the width blessed
actually put on screen — and not against the whole content, because on a scrolled pane the
drawn rows are the ones the reader pointed at. Releasing over the status bar therefore
copies the passage the drag started in, to its end, rather than reaching for content that
was never on screen.

## What is selected

A selection is two points, each a **line** and a **cell**:

- a **row** is an index into the lines of content — the same unit `childBase` is expressed
  in, so scrolling needs no correction of its own. The lines are read from blessed's own
  real table (`widget._clines`), which is deliberately *not* the wrapped rows: a mouse
  point names a line of content, and indexing the wrapped rows instead put the copied
  text one line below the one under the cursor whenever a row was wide enough to wrap;
- a **cell** is a terminal cell measured from the content's left edge, which is `ileft`
  columns in from the widget's own edge — the border plus the padding.

The two points are normalised to reading order, so dragging upwards copies the same thing
as dragging downwards, and the extraction is made **between grapheme clusters**: a cluster
is taken when any of its cells is inside the range, so a wide glyph or an emoji is copied
whole or not at all. Half a `👍🏽` in the saved file is worse than none.

Trailing whitespace is dropped from every copied row. A prose row is padded to the
region's width by its background band, and that padding is paint, not text — copying it
would put a screenful of spaces in the saved file.

## What is written, and where it goes

The text is written to a **file in the workspace**, and the name is the whole contract.

### Why a file, and not the clipboard

A program inside a container cannot reach the clipboard the user pastes from. That is not a
bug in the program; it is what a container is. Two approaches were tried and both are
hopes rather than facts:

- **a native clipboard tool** (`pbcopy`, `xclip`, `wl-copy`, `xsel`) is a *client of a
  display server*. Inside a container there is no display server — `DISPLAY` and
  `WAYLAND_DISPLAY` are unset — so the tool has nothing to talk to. It is not that the
  clipboard is in the wrong place; there is no clipboard in the container at all;
- **OSC 52** is a terminal escape sequence. It leaves the container as ordinary output and
  arrives at the *host's* terminal, which may honour it or may drop it in silence. xterm
  gates it behind its window-operations resource, tmux needs `set-clipboard on`, and many
  terminals do not implement it. A copy that "worked" because the sequence was written is a
  copy nobody can prove.

A file needs neither a display server nor a terminal's cooperation. It is written where the
user already is, and opening it is a command they already know. So the copy is a file, and
the honest thing the program can say is **where it put it**.

### The runner picks it up — the clipboard the user actually pastes from

The container cannot reach the host's clipboard, but the **host** can, and the runner that
starts the container already runs there. The workspace is bind-mounted both ways, so the
file the agent writes is a file the host can read; a watcher beside the container hands each
one to the host's own tool (`bin/lib/clipboard-watch.sh`):

| Host | Tool |
| ---- | ---- |
| macOS | `pbcopy` |
| WSL | `clip.exe` — Windows' own, reaching the real Windows clipboard |
| Wayland | `wl-copy` |
| X11 | `xclip -selection clipboard`, else `xsel --clipboard --input` |
| no display server | none — no watcher runs, and the file is still there to open |

The watcher is **started and stopped with the container**: a foreground `run` keeps it as a
child and ends it when the container returns, a detached `start` leaves it running until
`moncho-cli stop` (or `./start.sh stop`), and a pidfile under the workspace's `.moncho/` is
how the later command finds it.

Three rules make it trustworthy:

- **it is silent.** The TUI owns the terminal, so anything the watcher printed would corrupt
the display it exists to serve. Every one of its commands redirects both streams.
- **it never re-copies.** Everything already in the directory when it starts is marked seen
first. Otherwise starting the agent in a workspace holding last week's selection would
silently overwrite the clipboard on startup — the one thing a watcher must never do.
- **it never copies half a selection.** A file is handed over on the poll *after* the one
that first saw it, and only when its size did not change in between, so a write still in
progress is never read.

So the file remains the mechanism and the record, and on a host with a clipboard the text
also lands where the reader actually pastes from — which is what the whole feature was for.

### The name

```
<workspace>/.moncho.clipboard.HHMMSS
```

- **`.moncho.clipboard.`** is the prefix, and it is also the gitignore pattern
  (`.moncho.clipboard.*`). A saved selection is the user's scratch text, never project
  content, so it is ignored in this repository's `.gitignore` and in the runner's
  `.git/info/exclude` for a project workspace.
- **`HHMMSS`** is the local time of the copy, zero-padded — `09:15:07` becomes `091507`. The
  name is for the person reading it, not the program, so it is the time on their own clock.
- **the workspace** is the process's working directory, `/app` in the container. The file
  therefore appears in the bind-mounted directory the user is already looking at, and it
  survives the container.

Two rules keep the name honest:

- **a copy never overwrites another.** The file is created exclusively; if that name is
  already taken, the writer tries the next one. A second copy in the same second gets its
  own file, so a fast double-copy cannot destroy the first selection.
- **the text is written whole.** Unlike a terminal sequence there is no size limit to
  respect, so a large selection is saved in full. The medium is a file; it does not truncate.

### What the report says

The write returns `{ ok, name, path, bytes, error }`:

| Field | Meaning |
| ----- | ------- |
| `ok` | `true` when the file exists on disk |
| `name` | the file's basename, e.g. `.moncho.clipboard.091507` |
| `path` | the absolute path, for a caller that wants it |
| `bytes` | the byte length of the text written |
| `error` | `ENOENT`, `EACCES`, `EISDIR` and so on when the write failed — never thrown |

The report is what the toast is built from. An empty selection is not a failure — there is
nothing to save — and it produces no toast at all.

## What the reader sees

The toast is the only feedback, and it names the file:

> **Saved data to .moncho.clipboard.091507**

- **the sentence is the file's name**, because that is the thing the reader needs. "Copied"
  would be a claim the program cannot support; "saved" is a fact it can.
- **the toast sits in the top-right corner** for four seconds, never in the conversation's
  notice overlay and never as a row in the transcript — a copy is presentation, not dialogue.
- **the band is visible while the drag is live** and cleared on release, so the reader sees
  what will be saved before it is.

The saved file is the record. On a host with a clipboard tool the runner also hands the
text to it, so pasting works; on a host without one the file is still there to open, and
nothing in the program claims a copy landed when it cannot prove it did.

## See also

- The gesture and its blessed quirks: `app/transcript-mouse.js`, `app/transcript-select.js`
- The band that marks the selection: `app/transcript-highlight.js`
- The file writer and its naming rule: `app/clipboard-file.js`
- The sentence and its four seconds: `app/toast.js`, `app/tui-toast.js`
- The wiring that connects them: `app/tui-clipboard.js`
- The gitignore rules: `.gitignore` (`/.moncho.clipboard.*`), `bin/lib/git.sh`
- The host-side pickup and its lifecycle: `bin/lib/clipboard-watch.sh`, `bin/lib/container.sh`,
  `start.sh`
