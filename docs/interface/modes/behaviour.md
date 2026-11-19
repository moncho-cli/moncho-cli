# Interface — the session's intent mode: Chat, Design, Work

Most CLI agents blur the line between *talking about* code and *mutating* code: a
casual "how would we refactor this?" can trigger file edits, while an approved item
on `task.md` needs to run on its own. The system keeps the two apart with
**two separate notions**:

| Notion | Values | Meaning |
| ------ | ------ | ------- |
| **Intent mode** | `chat`, `design`, `work` | what the session is *for* right now |
| **Execution state** | `work:off`, `work:on` | a **lock**, not a mode |

Implementation: `app/session-mode.js`. The machine is **pure and terminal-free** —
`Tab` in the TUI (`app/tui.js`), `/work` in the command registry
(`docs/interface/commands`) and the line CLI all drive the same object, so the rules
below hold with or without a screen. The module paints nothing it cannot describe:
it answers the label, the colour and the state key, and the interface turns those
into the leftmost cell of the model row.

## The modes

- `chat` is **strictly read-only**: it creates no file at all. A session that never
  leaves `chat` leaves no trace in the tree, however creative the conversation gets.
- `design` may write **only** the two tracking files, `task.md` and
  `implementation_plan.md`: it is the mode that turns a discussion into a backlog,
  never the mode that turns the backlog into code.
- `work` executes the backlog. On its own it is a *mode* like the others; it is the
  `work:on` **lock** that makes it autonomous.

Anything that is not one of the three names is `chat`. `normalizeMode()` is the
single place that says so, so a corrupt session file, an environment variable or a
typo falls back to the safe, read-only default instead of granting write access.

## The cycle

- `Tab` walks **`chat -> design -> work -> chat`** (`nextMode()`), skipping nothing
  and in that order only. The mode is never derived from a prompt: the user picks it.
- Every accepted change is announced to the callers subscribed with
  `subscribe()`, so the TUI repaints the label exactly when the state moves — and
  never on a refused or idempotent move. A listener that throws is swallowed: a
  broken repaint must not cost the user their mode change.
- `setMode()` to the mode already current is a no-op (`changed: false`,
  `reason: 'same-mode'`): it does not notify and does not pretend something moved.

## The work lock

- `/work on` pins the mode to `work` **and** engages the lock (`setWork(true)`).
  `/work off` releases it and falls back to **`design`**, never to `chat`: the
  `task.md` the user was writing stays writable, so the clean workflow is
  `work:off` -> Design -> `work:on`.
- While the lock is on, **both** `cycle()` and `setMode()` are refused with
  `{ changed: false, reason: 'work-on', notice: WORK_LOCK_NOTICE }`. `work:on` is a
  lock, never a sandbox: the session stays reachable, chat messages steer it, and
  hot-editing the tracking files remains an explicit senior escape hatch — but the
  *mode* cannot move behind the user's back.
- Turning the lock on when it is already on (or off when it is already off) is a
  no-op, so a doubling of the command is harmless.

## The label and the colour

`describe()` returns the one state a view needs, and each state has exactly one
**bright** colour, so the mode is readable at a glance:

| key | label | colour |
| --- | ----- | ------ |
| `chat` | `Chat` | `green` |
| `design` | `Design` | `bright-cyan` |
| `work` | `Work` | `yellow` |
| `work:on` | `Work:on` | `bright-red` |

- `modeStateKey(mode, work)` is what makes the lock visible: the mode `work` with
  the lock on is the state `work:on`, which is why the locked session cannot be
  confused with a plain `Work` that `Tab` may leave.
- The interface paints that key as a coloured label at the **leftmost cell of the
  model row**, refreshed on every accepted change.

`app/session-mode-label.js` does that painting: `formatModeRow()` composes the tag
(the state's label in the state's bright colour) and the model identity after it,
and `createModeRow()` subscribes to the mode so a repaint happens on the accepted
changes alone — a refused `Tab` leaves the row showing the state the user is in.

## Persistence

`toJSON()` returns the plain, storable `{ mode, work }`; `createSessionMode()`
accepts the same two fields back, so a resumed session (`docs/runtime/session-store`)
keeps both its mode and its lock. A `work:on` state is restored as `mode: 'work'`
with the lock on, never as a plain `Work`.

## See also

- Implementation: `app/session-mode.js`
- The label on screen: `app/session-mode-label.js`
- The tools each mode may run: `docs/interface/modes` (`app/tool-guard.js`,
  `docs/agent/tool-multicall`)
- Commands that move the mode: `docs/interface/commands`
- The session file: `docs/runtime/session-store`
- Proof: `tests/session-mode.test.js`, `tests/session-mode-label.test.js`
