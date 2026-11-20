# Interface — the bands around the two sides of the dialogue

One screenful of transcript is mostly text, and the two sides of the dialogue — the
prompt the user typed and the prose the model wrote — sit among tool calls, results,
notices and errors with nothing but their first few words to tell them apart. This
spec fixes the **background band** that fixes that; the implementation is linked below.

The source is the backlog item:

> both user message and model prose chunks in the TUI should have like a nice
> background (different color for each) with 1 line margin top and bottom, so are
> easier to read in between all the text

## The two sides, and nothing else

`app/prose-band.js` names a band for exactly two roles:

| role | what it paints | background |
| ------------ | ------------------------------------ | ---------- |
| `user` | the echoed prompt (`docs/interface/user-messages`) | `blue` |
| `assistant` | the model's prose, and the reply that ends a turn | `red` — the dark red |

Any other role — a tool call, a tool result, a `[Context]` notice, an error, the
tracking rows — has **no** band: `bandColor()` answers `null` and `bandLine()` returns
the line byte-for-byte. A band can therefore never be applied by accident to a row
that is not one of the two sides.

## Why the model's band is the dark yellow

The user's `blue` is the one coloured band a terminal is certain to paint, so it stays.
The model's side was `grey`, and **grey was the bug**: blessed resolves it to bright
black (`\x1b[100m`), which on a dark terminal is all but the default background, so the
margins and the fill looked like transparent gaps rather than like a band.

The replacement is `yellow`, which blessed paints as the ANSI dark yellow (`\x1b[43m`)
— a brown on any ordinary terminal. A truer brown would need one of the 256-colour
indices, and blessed only reaches those when the terminal reports them: the hex tag
`{#8b4513-bg}` is silently mapped down to **red** (`\x1b[41m`) on a terminal that does
not, which would be a different colour on different machines. A brown that is sometimes
red is worse than a dark warm colour that is always brown, so the band names the one
colour a 16-colour terminal certainly has.

## Why the model's band is the dark red

Both bands are the **dark** form of their colour, so every foreground the palette paints
stays legible on top of them.

The model's side was `grey` first, and **grey was the bug**: blessed resolves it to
bright black (`\x1b[100m`), which on a dark terminal is all but the default background,
so the margins and the fill looked like transparent gaps rather than like a band. It then
briefly carried `yellow` (dark yellow, `\x1b[43m`), which read as muddy.

`red` is the ANSI dark red (`\x1b[41m`) — a burnt, brick red on an ordinary terminal,
and the exact peer of the user's `blue`: the same 16-colour palette, the same one name
the band has to go through. Red is *also* the palette's error foreground, and that is
safe precisely because of the band's oldest rule: an error, a refusal or any other row
that is not one of the two sides is **never banded** (`bandLine()` returns it
byte-for-byte), so no red foreground is ever painted on the red band.

## One blank banded row above and below

A banded entry is three things in the transcript: a blank row, the rows of the band,
a blank row. The margins are **part of the band** — the same background, the same
role — so they read as breathing room around the block rather than as a gap in the
transcript.

Two bands that meet **share** one blank row: the bottom margin of one and the top
margin of the next are the same row, not two. The rule lives in
`app/transcript-append.js#appendLines`, which appends a whole group at once — a margin
is only added when the previous entry is not already a blank banded row — so the
dialogue stays tight and the view stays the widget binding.

## The band is padded to its own width

The widget paints **background**, not a box, so a band that spans only its text would
end wherever the last word ends. `bandLine()` therefore pads the line to the region's
interior width *inside* the tag (with `app/tagged-text.js`), and the margin row is the
same padding with no text — the whole row is coloured.

The width is blessed's **own wrap width**, resolved at paint time from the live widget
(`width - iwidth`, less the cell blessed reserves for the scrollbar and the one it
reserves for a textarea). A band padded one cell past it would wrap into a second row,
which shifts every row below it and breaks the row-to-block map the block click reads
(`docs/interface/transcript-blocks`); a generous approximation is not enough, so the
number is read from the widget rather than guessed.

## The same two sides on the prose route

The band is applied by the *view*, so the two rows that log prose have to be told
apart from the rows that do not. That is the **prose route**:

- `ConversationManager.onProse(role, text)` is the hook; `notifyProse()` announces on
  it. It is presentation only, so a hook that throws is swallowed exactly like the
  other hooks (`docs/context/usage-refresh`).
- The seams that log a side wire to it: the user echo (`app/turn-runner.js`, which
  falls back to `onUserMessage` for a front end without one), the model's prose next to
  its calls (`app/tool-batch.js`), and the reply that ends the turn
  (`app/manager-turn.js`). Each falls back to its own plain `log()` when the route
  answers `null`, so a front end without a band behaves exactly as it always did.
- `main.js` wires `onProse` to `tui.logProse()` when the TUI is active and leaves it
  `null` otherwise: the **line CLI has no band** and keeps printing the plain quote
  `docs/interface/user-messages` describes.

A resumed conversation is banded like the live one: `replayChunks()` produces a
`prose` op for each side and `renderReplay()` prints it through `logProse` when the
front end offers one (`docs/interface/session-replay`).

## Presentation only

- The band is a pair of blessed tags on a **display line**; it is never stored on a
  context chunk or a session file, and `formatUserEcho()` still returns plain text.
- It adds **no visible glyph** except the padding and the two blank rows it declares,
  so the block-click row math is unchanged: a banded line is one display row and the
  model's line ranges say so.
- The **line CLI** never renders a tag, so a band can never appear there as literal
  `{blue-bg}` text (`docs/interface/line-cli`).

## See also

- Implementation: `app/prose-band.js`, `app/tagged-text.js`, `app/transcript.js`,
  `app/transcript-append.js`, `app/transcript-view.js`, `app/tui-transcript.js`,
  `app/tui-surface.js`,
  `app/conversation-manager.js`, `app/manager-hooks.js`, `app/manager-turn.js`,
  `app/tool-batch.js`, `app/turn-runner.js`, `app/session-replay.js`, `main.js`
- Spec of the echoed prompt: `docs/interface/user-messages`
- Spec of the row colours the band composes with: `docs/interface/conversation-colors`
- Spec of the surrounding screen: `docs/interface/tui`
- Spec of the reload that bands a resumed conversation: `docs/interface/session-replay`
- Proof: `tests/prose-bands.test.js`
