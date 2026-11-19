# Context — how long the session has been working

Three counters already exist and each answers a different question: the status
meter says how full the window is, the per-model table says what each model
consumed, and the call pulse says how many calls a stretch of work took. None of
them says how much wall clock the agent actually spent. This spec fixes that
fourth counter, and it fixes it as a **rule**; the implementation is linked below.

## What counts as work

| Span | Counted? |
| ---- | -------- |
| a model call — from the request leaving to its answer landing | **yes**, as `thinking` |
| a tool batch — from the first call dispatched to the last result collected | **yes**, as `tool` |
| the reader thinking between two turns, the process idling | no |
| the summariser call of a compaction | **yes**, as `thinking` (it is a model call) |

- The two kinds are kept **apart** (`utils/working-time.js#WORK_KINDS`), because
  they answer different questions: a slow model and a slow tool are different
  problems. `formatWorkRow()` reports their sum; the usage table reports both.
- A whole tool batch is **one** span, not one per call: the calls of a batch run at
  the same time, so timing them one by one would report the sum of a parallel batch
  instead of how long the user actually waited.
- Time is counted per **span**, tokens per **call**. A call retried twice is one
  request and three thinking spans; both facts survive, which is why
  `utils/usage-stats.js#applyTime` is a different function from `applyCall`.

## The clock

`utils/working-time.js#createWorkingClock` is the span bookkeeping, and it is
terminal-free:

- `begin(kind)` opens a span and answers a handle; `end(span)` closes it and
  answers **how long that span took**, so a caller can account it;
- while any span is open the clock ticks once a second (`WORK_TICK_MS`) so the row
  shows the number climb instead of jumping when the call lands. The timer is
  `unref()`ed, so an open span never keeps the process alive;
- `openTotals()` is what the row paints: the committed time plus whatever is still
  open. `isWorking()` says whether anything is open;
- `subscribe(fn)` is the repaint hook; a listener that throws is swallowed, because
  a broken front end must not be able to break the timing;
- `close()` releases the timer for good (screen teardown).

## The row

The counter is the row **directly above** the token meter, right-aligned against
exactly the same column (`app/work-row.js#createWorkRow`, built together with the
status bar by `app/status-rows.js#createStatusRows` so the two can never drift a
cell apart). Two rules make it behave like the row below it:

- it is right-aligned **through the same composer** (`composeStatusRow` with an
  empty left slot), so a resize re-pins both rows at once;
- it is **empty until there is something to say**: `formatWorkRow()` answers `''`
  while no time was worked, and a row reading `working 0s` from the first frame
  only teaches a reader to ignore it. The region keeps its row, so nothing above it
  moves when the number appears.

`formatDuration()` is the one spelling of a duration (`45s`, `3m 12s`, `1h 02m`):
seconds are dropped past the first hour and zero-padded inside a larger unit, so
the row keeps one width while it climbs. Junk and negatives read as `0s`.

## Where the time is kept

The clock is **host state**: it is never a chunk, never sent to the provider and
never stored on its own. What is persisted is the *committed* time, and it is
persisted per model, in the very same table the tokens live in
(`docs/context/model-usage`):

- `ConversationManager` times every model call
  (`app/conversation-manager.js#timedCallModel`, closed in a `finally` so a failed
  or retried call is still counted) and every tool batch
  (`#handleToolCalls`), and accounts each closed span through `#recordWorkTime`;
- the summariser call of a compaction is a provider call like any other, so
  `app/compaction-runner.js#createSummaryCallModel` times it too — but only when
  the session's clock was injected, so a tool-level test is simply untimed;
- the entry therefore carries `thinkingMs` and `toolMs` beside the token counters,
  the session file stores them with the rest of the table, and `/usage` appends
  `· working <dur> (thinking <dur>, tools <dur>)` **only when some time was
  worked**, so a table written before the counter existed keeps exactly the row it
  always had.

`workingTotals()` is what the screen paints: the stored table's totals plus the
open spans, so the number is continuous across a resumed session. `main.js` pushes
it to the surface (`tui.setWork`) on every tick.

## See also

- Implementation: `utils/working-time.js`, `app/work-row.js`, `app/status-rows.js`,
  `app/conversation-manager.js`, `app/compaction-runner.js`, `app/tui-surface.js`
- The table it is stored in: `docs/context/model-usage`
- Where the table is persisted: `docs/runtime/session-store`
- The row stack it belongs to: `docs/interface/tui`
- Proof: `tests/working-time.test.js`
