# Interface — the `/task` read-only viewer

`/task` shows the conversation's own tracking pair — its `task.md` and its
`implementation_plan.md` — **as they are on disk**, without leaving the prompt. It is a
reader: nothing it opens can be edited, and nothing it does writes a byte.

The pair belongs to the session (`docs/agent/task-tracking`), so this is the command that
answers "what is on my checklist right now" without the user opening a second terminal or
remembering the session folder.

## The command

- `/task` opens **both** documents, `task.md` first.
- `/task task` and `/task plan` open one of them, named by the same words the tracking
  tools use (`task` / `plan`).
- Anything else is refused with `UNKNOWN_ARG`, because a mistyped document name should not
  silently show the wrong file.
- A session with neither document answers `NO_TRACKING` and **creates nothing**: reading
  must never seed a pair the session does not have. A document that is missing while its
  sibling exists is reported in `missing` and left out of the box rather than shown empty.
- The documents are read through the same store the tracking tools use
  (`utils/tracking-store.js#readTaskContent`), so the file-then-record order, and the
  human's hot edit, behave exactly as they do for `update_task`.

## The modal

- The box is **read-only and verbatim**: it is built with `tags: false`, so a checklist
  containing `{braced}` text or a table shows its own bytes instead of being interpreted as
  a colour tag. `/task` is the view of what is really on disk, so a second, lossy rendering
  would defeat it.
- It fills **most** of the screen, never all of it: `contentModalSize()` subtracts a margin
  from each side and clamps to the terminal, so the conversation stays visible behind it.
- One box holds **both** documents; `tab` moves to the next one and the label says which
  document and its position (`task.md (1/2)`). Opening two boxes would stack two overlays
  for one question.
- `up`/`down` scroll one row, `pageup`/`pagedown` a page, `home`/`end` to the ends; the
  offset is clamped to the lines that really exist, so a short document cannot be scrolled
  into emptiness.
- `escape`, `enter` and `c`/`C-c` close it. The close resolves `{ closed, document }`, so a
  caller can tell how the user left.
- The keyboard is a **lease** (`app/keyboard-ownership.js`), released after the event that
  closed the box, and the input box takes the focus back — the same contract every other
  modal in the TUI follows.
- A front end with no screen (the line CLI, a bare tool call) gets the documents as plain
  lines instead, so `/task` is never a no-op.

## See also

- Implementation: `app/task-command.js`, `app/content-modal.js`, `app/commands.js`,
  `app/tui-surface.js`, `app/session-loop.js`
- The pair itself: `docs/agent/task-tracking`
- The commands that share the registry: `docs/interface/commands`
- Proof: `tests/task-viewer.test.js`
