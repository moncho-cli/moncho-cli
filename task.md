status: done

# The token meter refreshes on every call, not once per turn

The status bar carries the context-window meter, and the host paints it from the
`onContextChange` hook. Today that hook fires from **one** place: `maybeCompact()`,
and only when a compaction actually happened
(`app/conversation-manager.js#ConversationManager`). Everything else is painted by
`main.js` *around* the turn — once after `processInput()` resolves, once at startup
and once after a resume. So during a turn whose model answer costs four tool calls,
the meter sits still while the window grows by five chunks, and it only catches up
when the reply has already landed. The user cannot see a turn approach the budget;
the number they see is stale by exactly one turn.

This task makes the meter a *live* view of the window: every change to it is
announced, so the number on screen is the number the window holds right now.

## What "on every single call" means

The window changes in these ways, and each one must reach the host:

| Change | Where it happens today |
| ------ | ---------------------- |
| the user prompt becomes a chunk | `processInput()` |
| an assistant chunk carrying `tool_calls` | `handleToolCalls()` |
| each `tool` result chunk | `handleToolCalls()` |
| the final assistant reply chunk | `handleFinalResponse()` |
| the compaction rewriting the window | `maybeCompact()` |

On top of those, the usage is announced **immediately before every provider call**,
so the meter is already current when the request goes out — the moment the user
actually cares about, because that is the call that can be rejected for being over
budget.

## Constraints

- One emission path: a single guarded helper on `ConversationManager` announces the
  window's `stats()`, so no call site can forget the hook or bypass the guard.
- The hook is **display only**: a listener that throws is swallowed, exactly like
  `onUserMessage`, and never costs the user their turn.
- More repaints must not resurrect the compaction marker: the notifier is
  count-based (`app/compaction-notice.js#createCompactionNotifier`), so it still
  announces each compaction exactly once no matter how often it is asked.
- The line CLI keeps reporting usage per turn — a meter line after every chunk
  would drown the transcript; only the TUI paints the hook's output.
- Every file stays under the 300-line budget; extract rather than grow.

- [x] **announce every window change to the host** — `ConversationManager` gains one guarded emission helper used by every mutation point (the prompt, the tool-call chunk, each tool result, the final reply, a compaction), plus one emission right before every provider call, so the meter (and the compaction marker) track the window live instead of once per turn.
- [x] **document and prove the per-call usage refresh** — a `docs/context/usage-refresh` spec (registered in `docs/index.yaml`) states when the host is notified and what it must not do, and `tests/context-usage-refresh.test.js` proves the emission order, the pre-call refresh, the throwing-hook guard and the once-per-event compaction marker.

## Done when

- the spec exists, is registered, and names real `path#symbol` references and real test cases;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines.