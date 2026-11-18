# Interface — the conversation palette

One screenful of transcript mixes things of very different value: the prompt the
user typed, the tool calls the agent made, the results it got back, the context
notices, and the occasional error. On a monochrome screen they all look alike, so
the conversation is hard to skim. This spec fixes one colour per **kind** of row;
the implementation is linked below.

## The kinds

`app/theme.js` holds the palette as a frozen table, one blessed colour per kind:

| Kind | Rows | Colour |
| -------- | ------------------------------------------------------- | ---------- |
| `user` | the `You:` header of the echoed prompt | cyan |
| `tool` | `-> Calling …`, its `intent:` line, `[<tool> Output]`, a block header | yellow |
| `context` | `[Context]` usage and compaction notices | magenta |
| `error` | `Error …`, `[error] …`, a warning marker | red |
| `notice` | `[Info]`, `[Session]`, `[pasted …]`, horizontal rules | grey |

- The colours are **distinct**: the four parts of a turn never share one, so a
  glance at the colour is enough to tell "what I asked" from "what the agent did".
- Ordinary prose gets **no** colour. It is the majority of the screen and the
  terminal default reads best; the markdown renderer already colours the parts of
  a reply that carry structure.

## Classification

`classifyLine(line)` returns the kind of one already-rendered display line, or
`null`. It is pure string work, so the rules are unit tested without a terminal:

- the rules are ordered **most specific first**: an `[error]` row stays red even
  though a tool result may also carry a tool header, and the `You:` header is
  matched before the generic notice rules — it must be exactly `You:` on its own
  line, so prose that merely starts with that word is not mistaken for the echo;
- blank lines and unknown shapes return `null` (no colour), never a guess.

## Composing with the markdown renderer

`colorizeLine(line)` wraps a line in its tag; `colorizeLines(lines)` maps a whole
transcript. Both are applied at the end of `formatTranscript()`, which means:

- a line the markdown renderer **already tagged** (a fence, a tool delimiter, a
  quote, a heading, a list bullet, inline code) is returned **untouched** — the
  existing colours of `docs/interface/tui` are exactly as they were;
- the palette only ever *wraps* a line, never rewrites it, so the visible glyphs
  are unchanged. That matters for more than looks: the block click math
  (`docs/interface/transcript-blocks`) maps a screen row back to a display line,
  and a tag adds no visible width;
- nested tags are safe: neo-blessed restores the outer colour when an inner tag
  closes, so a coloured row keeps its colour after an inline `**bold**` or
  `` `code` `` span.

## Presentation only

- Colour never reaches the model. The chunk `ConversationManager` stores is the
  prompt itself (`docs/interface/user-messages`), the session file keeps the exact
  bytes (`docs/runtime/session-store`), and `formatUserEcho()` still returns plain
  text — the tags are added by the TUI renderer alone.
- The **line CLI** prints through `console.log` and never calls
  `formatTranscript()`, so a blessed tag can never show up there as literal
  `{yellow-fg}` text (`docs/interface/line-cli`).

## See also

- Implementation: `app/theme.js`, `app/tui-render.js`, `app/transcript.js`
- Spec of the surrounding screen: `docs/interface/tui`
- Spec of the echoed prompt: `docs/interface/user-messages`
- Spec of the collapsible results: `docs/interface/transcript-blocks`
- Proof: `tests/conversation-colors.test.js`
