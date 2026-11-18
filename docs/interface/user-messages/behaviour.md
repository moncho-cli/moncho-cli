# Interface — the user's own messages in the conversation

The transcript used to show one side of the dialogue: the model's replies, the
tool calls and the tool results, but never the prompt that caused them. A turn
therefore started with an assistant answer and the user had to remember what they
had asked. This spec fixes the echo that closes that gap; the implementation is
linked below.

## What is echoed

- `ConversationManager.processInput()` appends the prompt as the `user` chunk
  **and then announces it** through the `onUserMessage` option. The hook runs
  before the first model call of the turn, so the echo is on screen while the
  request is still in flight.
- The chunk is untouched: `onUserMessage` receives the prompt text, and the chunk
  stored in the context window (and sent to the provider) is exactly
  `{ role: 'user', content: prompt }`. The echo is **presentation only** — no
  prefix, marker or colour ever reaches the model or the session file.
- The hook is optional. Without one the turn behaves exactly as before, and a
  hook that throws is swallowed: losing the display of a prompt must never cost
  the user their prompt.

## How it renders

`formatUserEcho()` (`app/tui-render.js`) turns the prompt into display lines: a
`You:` header followed by every line of the message prefixed with `> `
(`USER_ECHO_PREFIX`). The text is sanitised first, so a prompt carrying ANSI
escapes or control characters cannot break rendering.

`formatTranscript()` paints a `> ` line as a coloured quote (`│ …`), which is the
same branch that renders a markdown blockquote coming from the model. The raw
marker never reaches the screen, and inline markup inside the quoted text
(`**bold**`, `` `code` ``) is rendered as usual.

The host (`main.js`) wires the hook to the front end's own logger, so both front
ends echo the message without knowing how it is formatted:

- **TUI**: the echo is transcript lines (`log()`), scrolled into view like any
  other output.
- **line CLI**: the echo is printed as plain lines, `You:` header included.

## See also

- Implementation: `app/conversation-manager.js`, `app/tui-render.js`, `main.js`
- Spec of the surrounding screen: `docs/interface/tui`
- Spec of the loop that stores the chunk: `docs/runtime/startup-wiring`
- Proof: `tests/user-echo.test.js`
