# Interface — the tracking announcement

`update_task` rewrites `task.md` and `implementation_plan.md` from inside a tool call, so
the write is silent for the person watching: the result goes back to the model, and the
two files are on disk somewhere under `agent/sessions/<id>/`. This spec fixes the one
line (or two) the conversation shows instead, in a colour of its own; the implementation
is linked below.

## One `[Tracking]` row per meaningful write

`app/tracking-notice.js` turns what `update_task` reports into transcript lines:

| What happened | Row |
| ------------- | --- |
| an item completed | `[Tracking] task.md · "item one" done — 1/3 items, next: "item two"` |
| the last item completed | `[Tracking] task.md · "item three" done — 3/3 items, checklist finished` |
| an item started | `[Tracking] task.md · working on "item two" — 1/2 items done` |
| the status line only | `[Tracking] task.md · status: in progress: item two` |
| a plan step ticked | `[Tracking] implementation_plan.md · step "step a" ticked — 1/2 steps` |
| the plan reset | `[Tracking] implementation_plan.md · reset for "item two" — 2 steps queued` |

- The **checklist line comes first, the plan line second**, because that is the order of
  importance: "the item is done" is the news, "the plan moved on" is the consequence.
- A `complete` therefore prints **two** rows; a `step` prints one; `list` prints none.
- Model text is **quoted and flattened** to a single row, so an item spanning several
  lines can never break the transcript.
- Counts are printed as `done/total` (`1/3 items`, `1/2 steps`), and a single step is
  singular (`1 step queued`).
- Nothing worth announcing is **silence**, never an empty row: `list`, an unknown action
  and a refusal produce no line at all, because nothing was written.

## The colour is its own

A tracking row is a **milestone**, so it must not read as the rows it sits between:
`app/theme.js` gives it `tracking: 'bright-green'` (`TRACKING_COLOR`) plus bold
(`TRACKING_BOLD`), and `colorizeTracking()` is the whole style in one place.

- It is distinct from every other kind in `docs/interface/conversation-colors` — the tool
  yellow, the context magenta, the error red, the notice grey and the user cyan.
- `classifyLine()` recognises it by its `[Tracking]` **prefix**, which is why the prefix is
  a constant (`TRACKING_NOTICE_PREFIX`) instead of being typed twice. Prose that merely
  contains the word "tracking" stays prose.
- The row is painted by the palette like any other: the notification itself returns plain
  text, so the line CLI prints it without a tag and the TUI renderer colours it.

## Presentation only

- The announcement is **not a chunk**: it never enters the context window, so the model
  never sees it and the request prefix stays cacheable (`docs/context/call-pulse`).
- It never reaches a session file: the bytes on disk are the two canonical tracking
  documents and nothing else.
- It is **optional wiring**: the tool reports the update through the `utils/host.js`
  registry (`notifyTrackingUpdate()`), and with no front end registered — a bare tool call,
  which is what the tool-level suites drive — the report is a no-op returning `[]`. The
  tool's own reply carries the lines it announced (`trackingLines`), so a caller can see
  exactly what was shown without reaching into the terminal.

## See also

- Implementation: `app/tracking-notice.js`, `app/theme.js`, `utils/host.js`,
  `tools/update_task.js`, `utils/tracking-step.js`, `main.js`
- The palette this row joins: `docs/interface/conversation-colors`
- The protocol that writes the files: `docs/agent/task-tracking`
- Where the files live: `docs/runtime/session-store`
- Proof: `tests/tracking-notice.test.js`
