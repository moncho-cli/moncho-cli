# The slash-command popup

When the input box starts with `/`, a popup opens directly above it listing the
matching commands, filtering as the user types, with `↑`/`↓` moving the highlight
(task-backlog):

> when user starts the message with a slash, identify it and show a popup there right
> on top with the matching commands and filter its as the user writes, arrows up/down
> let the user navigate the slash commands

## What it is

Presentation and one keystroke of help, nothing more. The popup is a **view of the
registry** (`app/commands.js#createCommandRegistry`): it reads `list()` on every
keystroke through a source function, so it can never offer a command `/help` does not
list. It is never a chunk, never reaches `context.json` and is never sent to a model —
the only thing that crosses into the context is the command the user **runs**.

## The query

A completion is a leading `/` and a name with no whitespace
(`app/slash-complete.js#slashQuery`), matching the character class
`parseCommand()` accepts (`[A-Za-z][\w-]*`, `app/commands.js#parseCommand`):

| in the box | the query | the popup |
| ---------- | --------- | --------- |
| `/` | `''` | every command, alphabetical |
| `/se` | `se` | the commands that answer it |
| `/sessions now` | — | closed: the name ended at the space, the box is typing arguments |
| `ask /help` | — | closed: a prompt that mentions a command is a prompt |
| `/1` | — | closed: not a name the parser would read |

A bare `/` lists everything on purpose: it is how a reader who does not remember the
commands gets the list, and it is the same list `/help` prints.

## The ranking

`app/slash-complete.js#rankCommands` answers a query through the **name** only, in two
tiers, ties broken alphabetically:

1. a **prefix** (`/co` → `compact`);
2. a **subsequence** anywhere (`/ses` → `sessions`, `/wrk` → `work`), which is what
   makes a skipped letter still find its command.

A command's **aliases** count as its name, because `/resume` really is an invocation of
`sessions`.

The **description is deliberately not searched.** It looked helpful and was not: every
description is prose, so `/co` matched `help` ("commands") and `sessions`
("conversations") and buried the command it was naming. A query the commands do not
answer leaves the popup **closed** and the box keeps taking a prompt, which is the
honest answer to a word no command answers.

## The rows

`app/slash-complete.js#slashRows` keeps the cursor inside the window exactly as the
picker does (`app/picker.js#createPicker.window`), so a long list scrolls instead of
overflowing, and `formatSlashRow` fits every row to the bar in **display cells**
(`app/cell-width.js#truncateToWidth`) so a wide glyph cannot wrap a row into a second
display line — the bug the queue preview had (`docs/interface/message-queue`). The
command **name is never truncated**: it is what the row exists to show, and it is short
by construction.

## The selected row

The row carrying the cursor is a **solid band**: a blue background (`blue-bg`, white
foreground, named once in `app/theme.js#SLASH_COLORS`) filled out to the region's
interior width with spaces, so it reaches the right padding instead of stopping short of
it. A row that is not selected carries no background at all.

This replaced **reverse video**, and it fixed a real bug in the same move: the box was
built with `tags: false`, so `{inverse}…{/inverse}` was not a tag at all — blessed
painted the braces and the marker sat in the middle of the row as literal text. A
background fill is also what the reader asked for, and it reads as a selection even on a
terminal whose inverse happens to match the border colour.

Because the band is drawn in cells, the width it is measured against must be the
**interior** one: the screen's width less the region's border and padding on both sides
(4 cells at 80 columns), not the screen's width. Both the fit and the fill come from that
one number, which is why a banded row is exactly as wide as the box's inside and never
wraps onto a display line the region's height does not have.

## The two accept paths

They are different on purpose (`app/slash-menu.js`):

- **Tab** completes the name into the box and adds a space (`slashCompleteText`), so
  arguments can be typed next. Nothing runs — completion is a sentence half-written.
  Because the space ends a query, the popup cannot spring back over the name it just
  finished.
- **Enter** takes the highlighted row and **submits** it (`slashAcceptText`), because
  pressing Enter on a menu entry means "do that one". The submission is the same one
  Enter on the line makes, so the box empties, the queue drains and the command is
  answered exactly as if it had been typed in full. The box is deliberately *not*
  written first: that would be a valid query and the popup would reopen over the
  command that is already running.

## Who owns the keys

The popup is a **third owner** of keys the box already uses, so the arbitration is one
pure function (`app/prompt-menu-keys.js#claimMenuKey`) asked **live** on each keypress —
a keystroke is exactly what opens and closes the menu:

- `↑`/`↓` move the popup's cursor while it is open and recall a prompt from the history
  when it is not (`app/prompt-keys.js`);
- `Enter` runs the highlighted row while it is open and submits the line otherwise;
- `Tab` is claimed **before blessed dispatches it** (`app/tui-keys.js#bindKeys`,
  `onComplete`), because a tab typed into a box is worse than a missed mode switch:
  while the popup is open it completes, otherwise it walks the mode ring
  (`docs/interface/modes`).

Moving the cursor repaints **through the bar**, not the screen: a move changes no text,
and the rows the bar holds are its own snapshot, so a repaint routed to the screen alone
left the highlight where it was.

## Where it sits

`app/slash-bar.js` anchors the box **directly above the input box** and grows upward,
because it belongs to what is being typed rather than to a corner of the screen. Its
`bottom` and its width are asked for on every paint: the queue bar sits between the box
and the conversation and changes height as messages are queued and drained
(`app/tui-layout.js#setQueueHeight`). It is hidden while it has no rows, so a closed
popup costs no cells and paints no frame.

The box and the popup are built as **one stack** (`app/tui-input-stack.js`) with the
focus guard that keeps the caret in the box, because they share the same keys and the
same two facts about the box being armed. They cannot be two independent regions without
two owners for one keystroke.