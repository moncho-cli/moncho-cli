# Context — usage refresh

The token meter in the status bar is a **view** of the context window, not a second
copy of it. This spec fixes *when* the host is told that the window changed, and
what it must never cost. Implementation:
`app/conversation-manager.js#ConversationManager`.

## When the host is told

The host is told after **every change** to the window, through one guarded helper
(`ConversationManager#notifyContextChange`), so no call site can forget the hook:

| Moment | Why it is worth a repaint |
| ------ | ------------------------- |
| the user chunk is appended | the prompt is already part of what the next call will send |
| right before **every** provider call | the meter shows exactly what is about to be sent, and this is the call that can be rejected for being over budget |
| the assistant chunk carrying `tool_calls` lands | the window just grew without any tool having run |
| **each** `tool` result chunk lands | a long chain of calls then climbs call by call instead of jumping at the end |
| the final assistant chunk lands | the number on screen is the number the turn ended with |
| a compaction rewrote the window | the meter must drop with the summary, not one turn later |

The host loop (`main.js`) therefore never repaints **after a turn**: it wires
`onContextChange` to the front end and lets the announcements do the work. It sets
the meter itself only where *it* replaces the window — at startup and after a
`/sessions` resume — because that change never passes through the manager.

## What the announcement must never do

- **A throwing listener is swallowed.** The hook is display only, exactly like
  `onUserMessage`: a broken meter must never cost the user their turn, so the loop
  catches and continues with an unchanged window.
- **No hook configured is a no-op**, not an error: the line CLI and the tests run
  the same manager without a meter.
- **Repetition is harmless for the compaction marker.** The notifier is count-based
  (`app/compaction-notice.js#createCompactionNotifier`), so announcing the same
  window ten times still prints a compaction notice exactly once per event.
- **The line CLI stays quiet.** Only the TUI paints the hook; the line CLI keeps its
  single `[Context] …` line per turn, because a meter line per chunk would drown the
  transcript.

## See also

- Implementation: `app/conversation-manager.js`, `app/context-window.js`,
  `app/status-row.js`, `main.js`
- The measurement itself: `docs/context/token-accounting`
- The meter and the compaction marker: `docs/interface/tui`
- Wiring of the loop: `docs/runtime/startup-wiring`
- Proof: `tests/context-usage-refresh.test.js`