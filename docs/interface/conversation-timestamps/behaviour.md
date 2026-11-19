# Interface — a timestamp on each conversation block

A transcript is a list of *entries* — a prose line, a tool-result block, the user's
own echo — and a reader scrolling back cannot tell whether two rows are a second or
an hour apart. This spec fixes the mark that answers that, in the TUI only; the
implementation is linked below.

## The mark

One `HH:MM:SS` string (`app/transcript-stamp.js#formatStamp`), taken in **local**
time: the reader is looking at their own clock, and a transcript that disagreed with
it by a timezone offset would be worse than no stamp at all. The mark is eight
characters wide (`STAMP_WIDTH`), always followed by one space, which is the shape
`STAMP_RE` recognises at the head of a display line.

- Junk — a missing date, an invalid one — yields `''`, and an empty stamp is what
  `withStamp()` renders as "no mark", never `NaN:NaN:NaN`.
- A stamp that does not look like one (a hand-made string from a caller) is
  **dropped**, not written into a conversation: the mark is decoration, and
  decoration must never be able to corrupt a row.

## One mark per entry

The mark is taken when an entry is **appended** and stored on that entry, so a
repaint — a block toggle, a scroll-driven `setContent()` — paints the very same
mark instead of a new one.

- A multi-line reply is stamped **once**, on its first line, so a long answer never
  becomes a column of identical times.
- An entry that opens with a blank line (the `\n  [tool Output]` shape the loop
  builds) is stamped where its text really starts, not on the blank row.
- A block carries its mark on its **header** line, in front of the fold glyph, so
  the glyph keeps the leftmost cell and every header still starts at the same
  column. The payload is never marked: the exact bytes stay verbatim.
- `createStamper({ now, enabled })` is the hook the view calls; `enabled: false` (or
  an unreadable clock) answers `null` for every entry, which `withStamp()` renders
  as no mark at all.

## It is display only

The stamp lives on the transcript entry, never on a context chunk: it cannot reach
the model and it is not stored in a session file. Two consequences follow:

- the line CLI, the pure view tests and any other front end build their rows with
  `stamp = null` and are byte-for-byte what they always were;
- a resumed conversation is replayed with stamping switched **off**
  (`app/transcript-view.js#createTranscriptView` → `setStamping(false)`, driven by
  `app/tui-surface.js#createTuiSurface`'s `reload()`): those rows appeared in a past
  run, so marking them with the time the file was reopened would state something
  false.

## Composing with the palette and the click

The mark is **part of the display line**, prepended rather than painted beside it,
so the block-click math (which counts display lines) is unchanged. The palette
tolerates it by seeing through it:

- `app/theme.js#splitStamp` splits a line into its mark and its content, so a
  stamped `You:` row is still the user's echo and a stamped tool header is still a
  tool row (`classifyLine`);
- the mark itself is painted in the low-key chrome colour (`STAMP_COLOR`), never in
  the colour of the row it introduces, so it can never be mistaken for content.

## See also

- Implementation: `app/transcript-stamp.js`, `app/transcript.js`,
  `app/transcript-view.js`, `app/tui-transcript.js`, `app/theme.js`,
  `app/tui-surface.js`
- The blocks it marks: `docs/interface/transcript-blocks`
- The palette that sees through it: `docs/interface/conversation-colors`
- A reloaded conversation: `docs/interface/session-replay`
- Proof: `tests/transcript-stamp.test.js`
