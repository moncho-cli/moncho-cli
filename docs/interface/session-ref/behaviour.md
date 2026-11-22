# Interface — `/ref`, the cross-session port

`/ref` carries a previous session's tracking pair into the current one. The case it
answers is the one the backlog names: *"hey, I was working there, let's resume here"* —
the work is in another conversation, and the user wants its checklist without dragging
its whole transcript along.

## What it ports, and what it does not

- It ports **the pair only**: `task.md` and `implementation_plan.md`. The conversation,
  the usage table, the skin and the mode stay behind — the point is a clean context with
  the work carried over.
- The source pair is read from the **session record**
  (`utils/session-format.js#sessionTaskContent`), not from the source folder's files, so
  a port carries what a resume would have carried.
- Each document is canonicalised (`utils/tracking-format.js#canonicalizeTrackingFile`) and
  validated before it is written, so a malformed source is refused with `INVALID_SOURCE`
  rather than imported.
- The write goes through `utils/tracking-store.js#writeTaskContent`, the same writer
  `update_task` uses, so the file and the session record agree and the bytes are canonical.

## The command

- `/ref <id>` ports from that session. A prefix is enough, exactly as `/sessions` accepts
  one.
- A bare `/ref` opens the session picker; a cancelled picker is `CANCELLED` and changes
  nothing. A front end with no picker is refused with `NEEDS_ID` and the session list,
  because guessing which checklist to import is not a small mistake.
- `/ref <id> --force` skips the confirmation. Without the flag the port asks first
  (`confirm(question, { title })`), because the current pair always exists — a session is
  seeded with one — so a plain port would silently destroy the user's own list. A refused
  confirmation is `CANCELLED` and writes nothing.
- The refusal codes are distinct: `NO_SESSIONS` (nothing stored), `UNKNOWN_SESSION`,
  `UNREADABLE`, `EMPTY_SOURCE` (the source never wrote a pair), `INVALID_SOURCE`,
  `NO_SESSION` (no session to port into).

## The announcement

A port is a tracking write, so it is announced like one: `utils/host.js#notifyTrackingUpdate`
receives `{ taskWritten, planWritten }` and the tracking announcer prints the
`[Tracking]` rows and the full-content block (`docs/interface/tracking-block`). The result
also carries `taskWritten` / `planWritten`, so the host can show what landed without
reading the result's prose.

## See also

- Implementation: `app/ref-command.js`, `app/commands.js`, `app/session-loop.js`,
  `app/cli.js`, `app/tui-surface.js`
- The pair it ports: `docs/agent/task-tracking`
- The sessions it reads: `docs/runtime/session-store`
- The commands that share the registry: `docs/interface/commands`
- Proof: `tests/ref-command.test.js`
