# Interface — the sticky last user message

A long turn buries the prompt it is answering: by the time the agent's tenth tool result
has scrolled past, the reader no longer remembers what they asked for. The backlog asks
for one behaviour:

> as the conversation scrolls upwards, the last user message should be kept stickied in
> the top position, with the timestamp, like, it should stop there, if the user sends a
> new message, when that new message enters the conversation the previous one is
> released and the new one will eventually occupy that first position again when it
> scrolls enough

Three facts make the behaviour, and `app/transcript-sticky.js` owns all of them.

## which prompt

The **newest entry on the `user` side of the dialogue** — the same `role` the prose band
is painted from (`docs/interface/prose-bands`), so the pin can never disagree with the
band about whose turn a row is. Blank banded margin rows carry the role too and are
skipped: they are padding, not text. A conversation the user has not spoken in pins
nothing.

## when it is shown

Only once the real row has **scrolled off the top**. The entry's display-line index is
compared against the viewport: the pin is due when the first painted row (`childBase`) is
past the row the prompt occupies. While the real prompt is still on screen the pin stays
hidden, because a pinned copy of a visible row would say the same thing twice. A caller
with **no geometry yet** — no layout, a stub in a test — is told not to pin: an unfinished
screen has nothing to explain.

That is also what "released when a new message enters" means, without any extra state: a
new prompt becomes the newest user entry, so the pin follows it down the transcript and
re-appears when *it* scrolls away.

## what it says

One row: the marker `⌖`, the prompt's timestamp, and the first line of the prompt,
**fitted to the width the region really has**. The mark is the one the entry was appended
with (`docs/interface/conversation-timestamps`), never a fresh clock reading, so the pinned
row and the real row always agree. A multi-line prompt is summarised to its first non-blank
line — a pin that grew with a long prompt would eat the conversation it exists to explain —
and the cut is made in **cells, between grapheme clusters** (`app/cell-width.js`), so an
emoji never loses half of itself and the row never wraps onto a second line the region's
height would clip.

**The row carries no markup, only the prompt's own characters.** A record is a *formatted*
line, not a coloured one: the renderer leaves three kinds of brace in it — a symbolic
palette tag (`{@quote-fg}` for a quote bar), a real blessed tag (`{bold}` for a heading) and
an escaped brace (`{open}`/`{close}` standing for a literal `{` the user typed). The
transcript resolves all three at paint time; the pin does not go through that path, so
`stickyText()` runs `app/paint-tags.js#stripTags` first. Two failures follow from skipping
it, and both were reported: `{@quote-fg}` **printed on screen as literal text** (blessed
does not know `@` as a tag character, so the symbol is inert as a tag yet still drawn), and
the width was **mismeasured**, because `displayWidth()` charges every tag character as a
visible cell — a budget meant for 20 glyphs was being spent on 22 cells of markup, then the
prompt was truncated to make room for bytes nobody sees. `stripTags()` undoes the escaping
in the same pass that drops the tags, so a literal brace the user typed survives as a brace
rather than being eaten by the tag stripper.

## how it is painted

`app/sticky-bar.js` is the widget binding, and it follows the notice overlay's shape
(`app/notice-bar.js`): a **floating** one-row blessed box over the transcript's first
content row, so the layout below never moves and a scroll is never a reflow. It is:

- **a view, not a copy** — it re-reads `lineRecords()` on every paint, so a prompt cut by
  a narrow window is re-cut when the window widens;
- **driven from the one place that knows the offset** — the transcript view calls back
  after every paint *and* after every move of the view (`app/transcript-view.js#repaintPin`),
  because a scroll moves the viewport without re-parsing the content. The move is announced
  from the **viewport's own repaint hook**, not from the view's `scrollRows`/`scrollPage`
  wrappers, and that detail is load-bearing: the viewport binds `wheelup`/`wheeldown` itself
  (`app/transcript-viewport.js`), so a wheel notch never passes through those wrappers.
  Announcing from them left the pin on screen while the real prompt was visibly back — the
  one route a reader is most likely to take;
- **chrome, not a message** — painted in the stamp colour and never in the user's band, so
  a pinned row can never read as a second prompt;
- **never focusable** — it is not clickable and reads no input, because the input box is
  the single arming point of the screen (`docs/interface/input-focus`).

Presentation only: the row names an entry that is already in the transcript, so it is never
a chunk, never in a session file and never reaches the model.

## See also

- Implementation: `app/transcript-sticky.js` (the three rules, pure),
  `app/sticky-bar.js` (the floating row), `app/transcript-view.js#repaintPin` (the
  repaint seam), `app/tui.js` (the wiring), `app/tui-teardown.js` (the resize re-fit)
- Spec of the band the role comes from: `docs/interface/prose-bands`
- Spec of the timestamp it carries: `docs/interface/conversation-timestamps`
- Spec of the scroll the pin follows: `docs/interface/transcript-scroll`
- Proof: `tests/sticky-user-message.test.js`