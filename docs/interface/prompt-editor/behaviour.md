# Interface — the input box as an editable line

The box the user types into had no editing model at all. neo-blessed's textarea
appends every printable byte to the **end** of its value and its own key listener
carries an explicit `// TODO: Handle directional keys.` with an empty body
(`lib/widgets/textarea.js`), so the arrows arrived and changed nothing and the
caret could only ever sit after the last character (task-backlog: "be able to use
arrow keys left and right to move through the text, and up/down to navigate
messages history").

This spec fixes the rules of the replacement; the implementation is linked below.

## count in cells

Everything that has to fit a width counts **display cells**, never code points
(task-backlog: "conversation to show unicode emojis properly"). The unit of text is
the **grapheme cluster**: an emoji sequence (`👍🏽`, `👨‍👩‍👧`, `❤️`) is one glyph of
two cells, a combining accent (`e\u0301`) is one glyph of one cell, CJK stays
double, and an empty string is zero. A wide glyph therefore costs two cells and a
zero-width mark none, which is what makes a fitted row still fit.

`truncateToWidth` charges the `…` to the budget, so the result never exceeds the
width it was given, and it cuts **between clusters**: a truncated line can never end
on half a surrogate pair or in the middle of an emoji, which is what a terminal
would otherwise paint as a replacement glyph. The same holds for every truncation
that counts characters rather than cells — the last-prompt hint
(`app/input-hint.js#formatLastPromptHint`), a notice
(`app/notice-overlay.js#formatNoticeText`) — which route through `cutCodePoints`.

### the screen is told the terminal really is unicode

Counting cells is not enough on its own, because neo-blessed decides whether to draw
a wide glyph from the **terminfo** entry it managed to parse (`screen.js#Screen`:
`this.fullUnicode = this.options.fullUnicode && this._unicode`). When it cannot read
one — no terminfo on the box, an unknown `$TERM` — it replaces every double-width
character with `??` (`element.js#Element.render`:
`content.replace(unicode.chars.all, '??')`), which is what turned every emoji in the
conversation into a question mark, whatever the width arithmetic did. The screen is
therefore built with `forceUnicode: true` (`app/tui.js#createTui`), the switch that
makes it trust the terminal rather than the entry: a `👍🏽` reaches the screen as
itself, and the cell counting is about the layout alone. `composeStatusRow`, which
pins the context meter to the right edge, measures in cells for the same reason.

## the editing model

`app/prompt-editor.js` owns one string and one caret, in clusters:

- `left`/`right` move the caret one cluster and report whether it moved; at the
  start or the end the caret stays and the key is not handled, so it falls through.
- `home`/`end` reach the edges.
- Typing (`insert`) lands **at the caret**, not at the end, and the caret follows
  what was typed.
- `backspace` removes the cluster before the caret and `delete` the one under it;
  on a skin-toned emoji the whole modifier sequence goes, so half a character is
  never left behind.

The value is never windowed: `window(maxCells)` returns `{ text, caretCells,
offset }` — the slice a one-line box of that width shows, the caret's column in
cells inside it, and how many clusters fell off the left. While the text fits, the
window is the whole text. Once it does not, the window **follows the caret** (the
cells ending at the caret are kept, then the room to its right is filled), which is
the honest version of blessed's `value.slice(-(width - 2))`. The bytes that are
submitted are always the whole value.

## the history

Up and down walk the prompts already **sent**, from `app/prompt-history.js`:

- `record(text)` stores one prompt. A blank submission and the `exit` sentinel are
  not prompts, a repeat of the newest entry is not stored twice, the list is bounded
  (`HISTORY_LIMIT`), and recording always ends a walk in progress.
- `prev(current)` walks back, keeping the text the box held when the walk began as
  the **draft**; `next()` walks forward and, past the newest entry, gives that draft
  back and ends the walk. Up and then down always returns the box to where it was.
- A key with nothing to recall is **not handled**: with an empty history the arrows
  keep exactly the behaviour they had before.

## the binding

`app/prompt-keys.js` is the only module of the three that touches neo-blessed, and
it does so in three contained moves:

- it replaces `_listener` **on the instance**, which is where blessed reads it from
  (`readInput()` binds `self.__listener = self._listener.bind(self)`), so the
  widget's own client code is never patched. Every key it does not handle — Enter,
  Escape, every control byte — is delegated to `Textbox.prototype._listener`
  unchanged.
- it keeps `value` and the private `_value` in step with the editor, so the widget's
  own `setValue()` (called from its `render()`) cannot paint its crude window over
  the caret-aware one.
- it paints the caret at its real column (`_updateCursor` and the bound
  `__updateCursor` are both replaced, because blessed's own resize handler calls the
  bound copy), since blessed places it at the end of the content.

The seam also tracks the text it last wrote, so a write from **outside**
(`clearValue()`, a test, the picker) is adopted while a change made through the
editor is published and not adopted back. Without a widget — the line CLI, a pure
unit test — every entry point is a harmless no-op.

`app/prompt-input.js` owns only *when* a submission happens: `settle()` and a queued
`submit()` empty the box through the seam and record what was really sent — a queued
message is a prompt the user sent, so the up arrow recalls it too.

## See also

- Implementation: `app/cell-width.js` (the cell counting), `app/prompt-editor.js`
  (the text and the caret), `app/prompt-history.js` (the walk),
  `app/prompt-keys.js` (the binding inside the widget), `app/prompt-input.js` (the
  armed question / queueing box), `app/tui.js#createTui` (the forced-unicode screen),
  `app/tui-render.js#composeStatusRow` (the cell-measured status row)
- Spec of the prompt as the model receives it: `docs/interface/user-messages`
- Spec of the queue the box feeds: `docs/interface/message-queue`
- Spec of the last-prompt hint over the same box: `docs/interface/tui`
- Proof: `tests/cell-width.test.js`, `tests/prompt-editor.test.js`,
  `tests/prompt-keys.test.js`, `tests/emoji-render.test.js`
