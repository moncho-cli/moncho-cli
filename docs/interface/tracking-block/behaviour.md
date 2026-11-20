# Interface — the tracking content block

`app/tracking-notice.js` announces the *milestone* of a tracking write: one `[Tracking]` row
saying an item was completed or a plan reset. That row says **what happened**; it never says
**what the file now contains**. The user watching the conversation still has to open
`task.md` to read the checklist the agent is working from.

`app/tracking-block.js` adds the second half of the announcement: a **titled block carrying
the full content of the file that changed**, painted in the palette's own contrasting
tracking colour (task-backlog: "when the task.md file is created, and each time
implementation plan is created, a tui only block with the full content in contrasting color
must show, with a title").

```
[Tracking] task.md (agent/sessions/<id>/task.md) · full content — 12 lines
  # Task list
  status: in progress: …
  ## Items
  - [x] …
```

## What is announced, and when

One tracking write produces **one call** into the announcer
(`createTrackingAnnouncer().notify(update)`), and that one call drives both halves:

| half | what it says | where it goes | when |
| --- | --- | --- | --- |
| the rows | what happened (`"item one" done — 1/2 items`) | the transcript, plain lines | always |
| the block | what the file holds (its full content) | the transcript, as a block | only where a block sink exists |

Which files get a block comes from the write itself: the tools report `taskWritten` /
`planWritten` (`tools/update_task.js`), and `trackingKindsWritten()` reads exactly those two
flags. So a `status` edit that moves no plan shows one block, a ticked step shows one block,
and a refusal — which writes nothing — shows none. The order is the protocol's own: the
checklist first, the plan after it.

## TUI only, and why

A block is what `logBlock` on the transcript pane draws (`app/transcript-view.js`,
`docs/interface/transcript-blocks`); the line CLI has no widget for one. So the rule is the
**presence of the block sink**, never a guess about which front end is up:

- the TUI wires `logBlock` and gets the rows *and* the blocks;
- the line CLI wires none, and the block half is a no-op — the announcement is exactly the
  rows it always was.

This is what keeps `main.js` honest: one `registerTrackingNotifier(createTrackingAnnouncer(…))`
call, with `logBlock: tui ? (block) => tui.logBlock(block) : null`.

## The content is read back, never remembered

The block's payload is the file **as it is on disk after the write**, read through
`utils/tracking-store.js#readTaskContent` / `readPlanContent`. A draft the tool normalised, a
canonical re-render, or a human hot-edit is therefore shown as it really is — the block
claims to show the file, and it shows the file. The read is injectable (`read`), so the shape
and the wiring are unit tested with no session at all.

The payload is the file's bytes verbatim, trailing newline included; a file with no content
gets an honest `(empty)` body and a `0 lines` title rather than nothing.

## The title and the colour

- The **title** is `[Tracking] <file> (<path>) · full content — N lines`. It leads with the
  `[Tracking]` label, which is what `app/theme.js#classifyLine` recognises, so the header
  itself paints as a tracking row.
- The **colour** is `TRACKING_BLOCK_COLOR` (`app/theme.js#TRACKING_COLOR`, bright green),
  handed to the block as `bodyColor` so `logBlock` wraps the whole payload in it. The
  tracking content therefore reads as the milestone it is, never as an ordinary tool result
  (`docs/interface/conversation-colors`).
- The block is **expanded**, not collapsed: the point is that the content is visible, and
  the header's size label is the reassurance that it is complete.

Like the rows beside it, the block is **presentation only**: it is never a chunk, never
written to a session file, and reaches neither the model nor a context window.

## See also

- Implementation: `app/tracking-block.js`, `app/transcript-view.js`, `main.js`
- The half that says what happened: `docs/interface/tracking-notice`
- The block shape and the palette: `docs/interface/transcript-blocks`,
  `docs/interface/conversation-colors`
- The registry both halves travel through: `utils/host.js`
- Proof: `tests/tracking-block.test.js`
