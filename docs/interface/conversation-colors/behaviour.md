# Interface — the conversation palette

One screenful of transcript mixes things of very different value: the prompt the
user typed, the tool calls the agent made, the reason for each call, the results it
got back, the context notices, and the occasional error. On a monochrome screen they
all look alike, so the conversation is hard to skim. This spec fixes one colour per
**kind** of row; the implementation is linked below.

## The kinds

`app/theme.js` holds the palette as a frozen table, one blessed colour per kind:

| Kind | Rows | Colour |
| -------- | ------------------------------------------------------------ | ----------- |
| `user` | the `You:` header of the echoed prompt | cyan |
| `tool` | `-> Calling …`, `[<tool> Output]`, a block header | yellow |
| `intent` | the `intent: …` row, and the `(intent: …)` span inside a tool row | bright blue, bold |
| `context` | `[Context]` usage and compaction notices | magenta |
| `tracking` | a `[Tracking]` task/plan milestone | bright green, bold |
| `error` | `Error …`, `[error] …`, a warning marker | red |
| `notice` | `[Info]`, `[Session]`, `[pasted …]`, horizontal rules | grey |

- The colours are **distinct**: the parts of a turn never share one, so a glance at
  the colour is enough to tell "what I asked" from "what the agent did".
- Ordinary prose gets **no** colour. It is the majority of the screen and the
  terminal default reads best; the markdown renderer already colours the parts of a
  reply that carry structure.

## The intent (task-backlog)

> the color of the intent text should be a brightish blue so is easier to find within
> the text, and bold

The reason for a call is the one line a reader actually wants when scanning a wall of
tool output, so it is the only row that carries two attributes:

- **colour**: `intent` is `bright-blue` (`CONVERSATION_COLORS.intent`,
  `INTENT_COLOR`). Plain `blue` is the dark terminal blue and disappears against a
  black background; the bright variant is the findable one.
- **attribute**: bold (`colorizeIntent()` wraps the span in `{bold}`; `INTENT_BOLD`
  records the decision). Bold survives where a bright colour is reduced: an 8-colour
  terminal folds `bright blue` into `bold` + the base blue, which is the same
  "brighter blue" reading.

`colorizeIntent(text)` is the whole style in one place. The two shapes the intent
takes are both covered:

- the standalone `intent: …` row under a `-> Calling …` line (`classifyLine()`
  returns `intent` for it, and the row is painted with the style from end to end);
- the `(intent: …)` span of a `[<tool> Output]` header — and the `intent: …` tail of
  a `-> Calling name(args, intent: …)` line — inside a row that already has a colour.
  `highlightIntentSpans()` recolours **only that span**, so the header keeps the tool
  yellow (or the error red) and the reader still gets "what this was for" at a glance.

Two consequences the tests pin down:

- the span ends at the `)` or `,` that closes it, so highlighting an intent never
  swallows the rest of the row, and it never rewrites the visible glyphs (the
  block-click row math depends on that);
- the style is a blessed tag name that really resolves. The tag parser rewrites `-`
  into a space and the colour switch spells the bright variant `bright blue fg`, so
  the tag is `{bright-blue-fg}` — `{brightblue-fg}` is not a known name and would be
  printed literally.

## Classification

`classifyLine(line)` returns the kind of one already-rendered display line, or
`null`. It is pure string work, so the rules are unit tested without a terminal:

- the rules are ordered **most specific first**: an `[error]` row stays red even
  though a tool result may also carry a tool header; the `You:` header is matched
  before the generic notice rules — it must be exactly `You:` on its own line, so
  prose that merely starts with that word is not mistaken for the echo; and the
  standalone `intent:` row is matched before the generic tool shapes so the reason
  for a call gets its own colour;
- blank lines and unknown shapes return `null` (no colour), never a guess. Prose that
  merely mentions the word intent (`the intent of this line is unclear`) is prose.

## Composing with the markdown renderer

`colorizeLine(line)` wraps a line in its tag; `colorizeLines(lines)` maps a whole
transcript. Both are applied at the end of `formatTranscript()`, which means:

- a line the markdown renderer **already tagged** (a fence, a tool delimiter, a
  quote, a heading, a list bullet, inline code) is returned **untouched** — the
  existing colours of `docs/interface/tui` are exactly as they were;
- the palette only ever *wraps* a line, never rewrites it, so the visible glyphs are
  unchanged. That matters for more than looks: the block click math
  (`docs/interface/transcript-blocks`) maps a screen row back to a display line, and a
  tag adds no visible width;
- nested tags are safe: neo-blessed restores the outer colour when an inner tag
  closes, so a coloured row keeps its colour after an inline `**bold**` or `` `code` ``
  span — and the intent span closes back into the yellow of the tool row around it.

## Presentation only

- Colour never reaches the model. The chunk `ConversationManager` stores is the
  prompt itself (`docs/interface/user-messages`), the session file keeps the exact
  bytes (`docs/runtime/session-store`), and `formatUserEcho()` still returns plain
  text — the tags are added by the TUI renderer alone.
- The **line CLI** prints through `console.log` and never calls
  `formatTranscript()`, so a blessed tag can never show up there as literal
  `{bright-blue-fg}` text (`docs/interface/line-cli`).

## See also

- Implementation: `app/theme.js`, `app/tui-render.js`, `app/transcript.js`
- Spec of the surrounding screen: `docs/interface/tui`
- Spec of the echoed prompt: `docs/interface/user-messages`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Proof: `tests/conversation-colors.test.js`
