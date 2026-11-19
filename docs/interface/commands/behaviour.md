# Interface — slash commands

Typed input that starts with `/<name>` is a **command**, not a prompt: the host
loop answers it locally and never sends it to the model. This spec fixes the
registry and the commands that ship with it; the implementation is linked below.

## The registry

- A command is a small object: `{ name, description, aliases?, run(ctx) }`, kept in
  a `Map` by `createCommandRegistry()`. Adding a command later is one `register()`
  call — the host loop, the front ends and `/help` need no change.
- `run(ctx)` receives `{ arg, log, choose, manager, dir }` and returns a plain
  result object (`{ ok, code, lines?, message?, ... }`). Commands never print
  directly; they return what happened and the host logs it, so both front ends
  behave identically.
- `parseCommand()` recognises `/name rest-of-line` (names are `[A-Za-z][\w-]*`) and
  returns `{ name, arg }`. Anything else — plain prose, a bare `/`, a slash in the
  middle of a sentence — returns `null`, so ordinary prompts reach the model
  untouched.
- `runCommand(registry, name, ctx)` resolves aliases and returns `null` for an
  unknown name, which is what makes "Unknown command /x. Try /help." possible.

## The commands

- **`/work [on|off]`** — the execution lock (`docs/interface/modes`). It moves the
  *live* session state, not a copy: `run(ctx)` receives the `createSessionMode()` the
  tool gate already reads, so a typed `/work on` tightens the very next call.
  - `/work on` refuses when there is nothing to drive: no `task.md`, a file with no
    checkbox items, or one whose items are all done. A refused `on` leaves the mode
    and the lock exactly where they were.
  - an accepted `/work on` pins the mode to `Work`, engages the lock, and reports how
    many items are still pending plus the next one in line.
  - `/work off` releases the lock and falls back to `Design` — never `Chat`, so the
    `task.md` the user was writing stays writable.
  - `/work` with no argument reports the current state; an unknown argument is refused
    with its own code, so a typo never engages the lock.
  The checklist is read through `readTaskItems()` in `app/work-command.js`, which parses
  the file with the same checkbox syntax the tracking tools use
  (`docs/agent/task-tracking`).
- **`/sessions [id]`** (alias `/resume`) — list the stored conversations
  (`docs/runtime/session-store`) and continue one:
  - no stored session: says so and changes nothing;
  - `choose` available (a picker): offers the one-line summaries, and the chosen
    session's chunks are replayed into the live `ContextWindow`;
  - no picker: the summaries are logged as plain lines;
  - `id` given: resumes that session directly, prefix match included;
  - a cancelled pick, an unknown id or an unreadable file each return their own
    code and leave the window untouched.
  The `RESUMED` result also carries the loaded chunks, the id and the session's
  start date, because resuming is more than a window swap: the host **reloads the
  conversation view** from them and adopts the id, so the reloaded dialogue is on
  screen and later turns are saved into the same file
  (`docs/interface/session-replay`).
- **`/usage`** — the per-model token breakdown of this session
  (`docs/context/model-usage`): one line per model, **alphabetical** so two runs
  compare line by line, with the request count, the exact/estimated split and the
  prompt, completion and total tokens. A total line is added when more than one
  model answered, and an explanatory line when the table is still empty. It reads
  the live meter, so `/usage` works while the session is running and after it is
  resumed. It does **not** replace the status bar: the meter shows how full the
  window is right now, `/usage` shows what was spent.
- **`/help`** — the command list, derived from the registry itself.

## The picker

The choice itself is a pure model (`app/picker.js`): a cursor, a page window and
the display lines. It wraps at both ends, clamps absolute jumps, keeps the
highlighted row inside the window and renders an empty list as one explanatory
line.

Each front end renders it its own way:

- **TUI**: `createPickerModal()` (`app/tui-modal.js`) draws a centred bordered box,
  consumes the keys itself (locking the screen's dispatch so the input box and the
  transcript do not also react), and resolves with the item — or `null` on Escape /
  Ctrl+C. `chooseLabel()` adapts that to the **index** contract the commands use.
  Closing the modal restores the focus to the input box but must **not** start a
  read of its own: the host arms the next prompt (`question()`) and that is the
  single arming point. Otherwise the box carries two read cycles, every keystroke
  lands in it twice, and typing after `/sessions` repeats each character.
- **line CLI**: `createCLI().choose(labels)` prints a numbered list and reads the
  number back; an empty answer, `q` or an out-of-range number cancels.

## See also

- Implementation: `app/commands.js`, `app/picker.js`, `app/tui-modal.js`,
  `app/cli.js`, `main.js`
- Spec of the numbers `/usage` prints: `docs/context/model-usage`
- Spec of the stored sessions: `docs/runtime/session-store`
- Spec of the reload after a resume: `docs/interface/session-replay`
- Proof: `tests/commands.test.js`, `tests/tui-modal.test.js`
