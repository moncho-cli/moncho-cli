# Interface — selecting text in the conversation and copying it on release

A terminal keeps its own selection: the terminal paints it, the terminal holds it, and
the process is never told it happened. So Moncho makes the selection itself — in the
conversation's own model — and hands the result to the terminal with **OSC 52**, which
is the one way a TUI can put text on the clipboard of the machine the user is sitting at.

This spec fixes what a drag means, what a plain click still means, what is written, and
what the reader is told — including the one neo-blessed behaviour that decides the whole
design. The implementation is linked at the bottom.

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
whole or not at all. Half a `👍🏽` on the clipboard is worse than none.

Trailing whitespace is dropped from every copied row. A prose row is padded to the
region's width by its background band, and that padding is paint, not text — copying it
would put a screenful of spaces on the user's clipboard.

## What is written, and how it gets there

Two paths, tried in this order, because they are not equally trustworthy.

### 1. A native clipboard tool — the one that really delivers

`app/clipboard-native.js` hands the text to the platform's own tool and checks its exit
status:

| Session | Tool |
| ------- | ---- |
| macOS | `pbcopy` |
| Windows | `clip.exe` |
| Wayland (`WAYLAND_DISPLAY` set) | `wl-copy`, then `xclip`, then `xsel` |
| X11 | `xclip -selection clipboard`, then `xsel --clipboard --input`, then `wl-copy` |

A tool that exits 0 has **really put the text where the user will paste it**, which is the
only kind of proof this feature can have. A tool that is not installed is remembered as
missing (`ENOENT`), so a box without `xclip` pays for one failed process per session and
never again; every spawn is bounded by a timeout, because a wedged clipboard daemon must not
freeze the conversation.

### 2. The terminal's own clipboard — OSC 52, the fallback

`app/clipboard.js` builds one escape sequence and writes it to the terminal:

```
OSC 52 ; c ; <base64 of the UTF-8 text> BEL
```

This is the only clipboard a *bare* terminal offers a program, and it is what still works on
a machine with no clipboard tool at all — an SSH session into a container, a minimal image.
It is deliberately **second**, because it is a hope rather than a fact: the terminal may
implement it and may not. xterm gates it behind its window-operations resource, tmux needs
`set-clipboard on`, and a terminal that does not implement it **drops the sequence in
silence** — which looks exactly like a copy that never happened, confirmation toast and all.
That is why the native tool is tried first.

The sequence itself has three properties, each a rule:

- **bounded.** Terminals drop or truncate an oversized OSC 52, and a copy silently cut in
  half is worse than one that says it was cut. The text is trimmed to
  `CLIPBOARD_MAX_BYTES` (100 KB) of *encoded* payload — the unit the terminal counts —
  always between clusters, with a `…` charged to the budget, and the report says
  `truncated: true` so the caller can say so.
- **multiplexer-aware.** tmux and GNU screen swallow a bare OSC 52 unless it is passed
  through in their own envelope, so the writer wraps the sequence for whichever one the
  environment names.
- **never fatal.** A missing or throwing writer is reported as `ok: false` with a reason,
  never propagated: a copy is a convenience, and losing the clipboard must not take the
  conversation down with it. An empty selection is not a copy at all and emits nothing,
  rather than a sequence that would clear the user's clipboard.

## What the reader sees

- **the selection is marked** while the drag is live: reverse video over exactly the cells
  that will be copied, so what is marked and what is copied cannot disagree. The mark is
  inserted at a cell boundary through the line's own tags, which keeps a row's colours —
  a cyan `You:`, a bold heading — readable *under* it; a line with no selection comes back
  byte-for-byte. The mark is cleared the moment the gesture ends.
- **the copy is confirmed** by a small bordered box in the **top-right corner** reading
  `Copied text to clipboard` (`app/toast.js`, `app/tui-toast.js`). It is deliberately not
  the transient notice overlay: that one carries provider news — a retry, a failure — and
  holds it for three minutes across the whole width, because a reader who looked away must
  still find it. A copy is something the reader just did on purpose and needs only a
  flicker of proof, so the toast is one plain sentence, four seconds, in a corner.
- **a failure says why** in the same corner (`Could not copy: <reason>`), because silence
  would leave the reader believing their text had been captured. An empty selection is
  silence: nothing was selected, which is not a failure.

Both are presentation only. A selection is never a context chunk, never reaches the model
and never enters a session file, and the line CLI — which wires no transcript pane — is
untouched.

## See also

- The gesture and the extraction: `app/transcript-select.js`
- The escape sequence and its bounds: `app/clipboard.js`
- The native tool that delivers first: `app/clipboard-native.js`
- The reverse-video mark: `app/transcript-highlight.js`
- The mouse binding and the event order: `app/transcript-mouse.js`
- The pane that owns it: `app/tui-transcript.js`
- The confirmation and its four seconds: `app/toast.js`, `app/tui-toast.js`
- The transcript model and the row-space math: `docs/interface/transcript-blocks`
- The band a copied row is padded by: `docs/interface/prose-bands`
- Proof: `tests/clipboard-selection.test.js`, `tests/clipboard-selection-tui.test.js`,
  `tests/clipboard-mouse-wire.test.js`, `tests/clipboard-copy.test.js`,
  `tests/clipboard-highlight.test.js`, `tests/toast.test.js`, `tests/tui-toast.test.js`
- The encoding a real terminal sends, and where blessed misreads it:
  `node_modules/neo-blessed/lib/program.js#_bindMouse`