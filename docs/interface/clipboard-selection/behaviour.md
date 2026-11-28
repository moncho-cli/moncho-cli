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

### A drag step costs one paint per turn, not one per report

The band is repainted during a drag only when the point really **changed**, and that repaint
is **coalesced to one per turn** (`app/paint-coalescer.js`). Both halves are load-bearing,
and both answer the same reported symptom: *"when the conversation is very long, it really
lags … like a second to catch up with the position of the cursor"*, while a short one is
instant.

A paint is not cheap — it re-renders **the whole conversation** (`paint()` in
`app/transcript-view.js` maps every record through the palette, bands every line, highlights
every line, hands the lot to `setContent()` and repaints the screen). So a drag step's cost
grows with the length of the transcript, which is exactly what the reader feels.

A fast drag arrives as a **burst**: blessed decodes a chunk of input and emits every report
it contained in the same synchronous turn, so a flick of the wrist is dozens of reports
before the event loop turns. Painting for each cost the *sum* of those paints, and the band
fell further behind the pointer the longer the conversation was.

Two things make it one paint instead:

- **a changed point, not every report.** One report reaches the gesture twice — the widget it
  landed on *and* the screen, which re-emits every report — and a repeat press on the same
  cell is not a move. The comparison is by **value** (`isSamePoint`): an identity test on two
  freshly-built point objects is always true, so it repainted for every duplicate report;
- **one paint per turn.** Every request made before the turn ends collapses into the single
  paint at the end of it, which is the same paint the last request would have produced — so
  the band still lands on the pointer's final position, and the frames in between are work
  never done rather than work thrown away. It is deliberately **not** a clock-based throttle:
  an arbitrary interval would make the band lag the pointer by design.

The release is the one edge that bypasses the coalescer: it paints **at once** and drops any
pending coalesced paint first, because the band has to leave the screen at that instant and a
late paint would redraw the very band the release just cleared.

**The coalescer is not the whole answer, and an earlier revision of this section overstated
it.** Measured with every report emitted synchronously in one turn, a 40-step burst dropped
from 83 paints to 2 — but a real terminal delivers each report in its **own** event-loop
turn, so nothing collapses and the same 40-step drag still caused ~42 paints. The count only
looks fixed when the reports are batched. What a drag step actually costs is therefore one
paint, and the fix that matters is making that paint cheap: `highlightCells()` segments the
line in one pass instead of re-segmenting the remainder at every character (measured 55.6ms
→ 1.55ms over 40 lines), and the decorator leaves a line it does not touch byte-for-byte.
Measured after those changes, on a 1600-entry transcript: **0.22–0.40ms per drag step**, from
~38ms before.

### Shift belongs to the terminal, so no modifier opens a gesture

**A bare press opens the gesture, and Shift deliberately does not.** Shift+drag is the
*terminal's* chord, not this program's: xterm, iTerm2, Kitty, Windows Terminal, Ghostty and
Warp all treat it as a request to **suspend mouse reporting** so the reader can select with
the terminal itself. Ghostty's VT documentation states the consequence outright — "the
running terminal program cannot detect shift-clicks because the terminal emulator captures
the event" — and the same is true of the other emulators' Shift+drag handling.

An earlier revision of this feature tried the opposite rule — Shift *required* to open a
selection — and it could not work, for two reasons that both follow from the above:

- **the press is not ours.** The terminal captures Shift+mousedown (or, on some emulators,
  a Shift+mousemove) and never reports it, so the gesture never opens on the cell the reader
  meant while the terminal paints its own selection over the conversation;
- **the release is not ours either.** Where a press does slip through, the release that
  follows it can be swallowed the same way, and the band this program painted is left
  stranded on screen with nothing copied.

So the two selections are **complements rather than rivals**: a bare drag copies into the
file this program writes, and a Shift+drag is the terminal's own native selection, which the
reader pastes with the terminal's paste key. Nothing in this program tries to own Shift, and
nothing fights the terminal for the mouse.

This is why no `data.shift` check appears in the gesture: had the reader the muscle memory
of a TUI that hijacks bare drags (htop, vim on some setups), Shift+drag is the escape hatch
they already reach for, and it is the terminal — not this program — that answers it.

### Handing the mouse to the terminal (`NATIVE_SELECTION_ENABLED`)

The terminal's own drag-to-select and its copy key are an alternative to everything above,
and the switch is **opt-in**: left unset, this program owns the mouse and the drag-to-copy
band described above is what a reader gets. The two cannot both own a bare drag: blessed
enables mouse reporting the moment **any** mouse listener is bound
(`screen.js#_listenMouse` -> `program.enableMouse()`), and while a terminal is reporting the
mouse it sends drags to this program and keeps its own selection off. So the switch is not
"disable our gesture" — a bare drag would then be answered by neither — but "do not ask for
the mouse at all".

**Off by default, and the reason is the cost.** Every mouse interaction in this program is
built on the reports the switch gives up, so turning it on takes all of them away at once:

- **the in-app selection** and the file it writes — the copy is the terminal's, so nothing
  here ever sees a selection and no `.moncho.clipboard.*` file appears;
- **the wheel.** Keyboard scrolling is unaffected (`pageup`/`S-up`, `pagedown`/`S-down`,
  `home`, `end` in `app/tui-keys.js`);
- **the click-to-expand tool block.** A block's body has **no keyboard or command path**
  today — `toggleBlock` is reachable only through `clickAt` — so a reader who needs a tool
  result's body reads the file the tool wrote, or leaves the switch off;
- **the click that removes a queued message** (`app/queue-bar.js#clickAt`).

A default that silently removed four interactions would be a poor default, so the mouse stays
with this program unless a reader asks otherwise. A reader who prefers the terminal's own
selection sets the variable and knows what they are trading.

**`NATIVE_SELECTION_ENABLED=1`** (also `true`, `on`, `yes`, `y`) hands the mouse to the
terminal. `app/tui-screen.js` makes `program.enableMouse()` a no-op, which is the only place
that can decide it: the negotiation is a side effect of binding a listener, not an option,
and blessed re-arms it from `Screen#resume` as well. No `?1000`/`?1002`/`?1003`/`?1006` is
sent, so no report ever reaches this program and the terminal's native selection works.
`app/tui-transcript.js` goes further and does not bind the gesture, the click or the band
decorator at all, so nothing answers a report and nothing arms the dispatcher.

**The alternate screen bounds it.** blessed draws into the terminal's alternate screen
(`screen.js#enter` -> `program.alternateBuffer()`), so the terminal can select only what is
*drawn*; the scrollback of a long conversation does not exist for it. A reader wanting older
lines scrolls this program to them first, and then selects.

**Shift+drag is the middle ground the terminal already offers.** With the switch off — the
default — a reader who wants a one-off native copy does not need the flag at all: Shift+drag
is the chord every major emulator intercepts to suspend mouse reporting, so the terminal
selects natively for that drag while the program keeps the mouse for everything else. That is
why the in-app gesture deliberately ignores modifiers (`### Shift belongs to the terminal`).

### The encoding is SGR, so a modified release still reads as a mouseup

The gesture *finishes* on `mouseup`, so a release that decodes as anything else leaves the
band stranded and copies nothing. Which encoding the terminal speaks decides whether a
release carrying a modifier survives that trip.

blessed negotiates the protocol from `$TERM`, and on every xterm-like terminal it asks for
**?1005, the UTF-8 extended X10 encoding** (`program.js#enableMouse`, the xterm branch:
`utfMouse: true`). X10 packs the button **and** the modifiers into one byte and has no
separate field for the *edge*: its decoder does `b -= 32` and then tests `b === 3` for a
release, which a plain release (`35 - 32 = 3`) passes and a release carrying a modifier
(`35 + 4 = 39`, `39 - 32 = 7`) fails — arriving instead as `mousedown` with
`button: 'unknown'`. blessed's own comment admits the limitation: "x10 and urxvt have no way
of telling which button mouseup used".

That is what strands a band, and it is not specific to Shift: X10 cannot carry a modifier on
a release at all. `app/tui-screen.js` therefore replaces blessed's `enableMouse` and asks
for **?1006 (SGR)**, where the button and the modifiers are decimal parameters and the edge
is the final byte (`M` press, `m` release). blessed already decodes that correctly, so a
release with any modifier is still a `mouseup` and always finishes the gesture.

This is why the wire suite writes SGR reports **and** asserts that the app asks for SGR: the
suite fires reports past the decoder, so without that assertion a revert to ?1005 would leave
every case green while a modified release stranded the band in the reader's hands.

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

The drawn range is concrete: the first row on screen is `childBase`, and the last is
`childBase` plus the rows the pane can hold, less one — **clamped to the last row that
exists**. Both edges matter. A release below the pane must stop at the pane's last row and
not at `childBase + _clines.length - 1`, which adds the scroll *base* to a *content* length
and so names a row far below the last one drawn (a measured 130 against 79) — the copy then
ran on through every row in between, text the reader never saw. A release above the pane
must stop at `childBase` for the same reason in the other direction: the rows above it are
history, not something the pointer reached.

## What is selected

A selection is two points, each a **line** and a **cell**:

- a **row** is an index into the **wrapped rows** the widget put on screen — the same unit
  `childBase` is expressed in, so scrolling needs no correction of its own. The rows are read
  from blessed's own wrapped table (`widget._clines`, one entry per row drawn); the logical
  lines *before* wrapping are the other table it hangs off the same array
  (`_clines.fake`), and indexing *those* put the copied text one line below the pointer
  whenever a row was wide enough to wrap;
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

### How many files are kept

`CLIPBOARD_FILE_KEEP` (`config/constants.js#CLIPBOARD_FILE_KEEP`) decides what a copy
leaves behind, and it has two modes:

- **`single` — the default.** A new copy prunes the earlier clipboard files, so the
  workspace holds exactly one saved selection: the last one. This is the behaviour a
  reader wants by default, because the saved text is scratch, not project content.
- **`all` — opt-in.** Every copy keeps its own timestamped name, so the workspace is a
  history of selections. `timestamped` and `keep` are accepted spellings; anything else
  falls back to `single`, the side of the knob that leaves *fewer* files.

Two details make it safe:

- **the name still changes with the clock in both modes.** The host-side watcher
  (`bin/lib/clipboard-watch.sh`) hands a selection over when a **new** name appears, so a
  fixed name would be seen once and never again; `single` mode therefore keeps the
  timestamped name and prunes the others rather than reusing one name.
- **pruning is best-effort and prefix-scoped.** It runs only **after** a write has landed,
  so a copy that failed leaves the previous selection untouched; it only ever removes
  files carrying `CLIPBOARD_FILE_PREFIX`, so an ordinary file in the workspace can never
  be deleted by a copy; and a prune that fails is swallowed, because losing a stale
  scratch file must never cost the user the copy that succeeded.

The rule the modes share is unchanged: a copy still **creates** its file exclusively and
never truncates an existing one, so no two selections ever race over one name.

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

## Also the read-only viewer

The same gesture, the same band and the same writer serve the **content modal** that
`/task` opens (`docs/interface/task-viewer`, `app/content-modal.js`): a reader who knows how
to copy a transcript row already knows how to copy a line of `task.md`. Three facts make it
work there:

- **the box parses tags.** A band is spliced into a line (`highlightRows`), which a
  `tags: false` box cannot host; the document is written through `escapeTags()`, so what is
  drawn is still the file's own bytes, braces included.
- **the mouse is given back.** A modal takes the keyboard as a lease
  (`app/keyboard-ownership.js`), and `screen.lockKeys` gates blessed's *mouse* dispatcher as
  well as its key one — so a modal that kept it would be a viewer nothing can be selected
  in. `unlockMouse()` clears the flag while the lease stands: the keyboard stays the
  modal's, the pointer reaches the box, and the regions behind it are safe because each
  already opts out of focus and answers no drag. This is why a modal opened *mid-turn* is
    still safe to read out of (`docs/interface/busy-commands`).
- **the mouse is the terminal's only when the switch says so.** The modal binds the same
  gesture, so with the default (`NATIVE_SELECTION_ENABLED` unset) it selects and copies into a
  file exactly as the conversation does. Setting `NATIVE_SELECTION_ENABLED=1` hands the mouse
  to the terminal, no mouse reporting is negotiated, and the modal's band stays quiet — the
  reader selects there with the terminal's own drag. The binding stays in place either way
  because it costs nothing when no report arrives, and it is what makes the switch work
  without a second code path.

## See also

- The gesture and its blessed quirks: `app/transcript-mouse.js`, `app/transcript-select.js`
- The modal that reuses them: `app/content-modal.js`, `docs/interface/task-viewer`
- The band that marks the selection: `app/transcript-highlight.js`
- The file writer and its naming rule: `app/clipboard-file.js`
- The sentence and its four seconds: `app/toast.js`, `app/tui-toast.js`
- The wiring that connects them: `app/tui-clipboard.js`
- The gitignore rules: `.gitignore` (`/.moncho.clipboard.*`), `bin/lib/git.sh`
- The host-side pickup and its lifecycle: `bin/lib/clipboard-watch.sh`, `bin/lib/container.sh`,
  `start.sh`
