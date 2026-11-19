# Interface — interrupt controls (ESC / Ctrl+C)

One key pair, one entry point, two front ends. This spec fixes what ESC / Ctrl+C do
in every state so cancellation never depends on which UI owns stdin. The
implementation is linked below.

## One entry point

- Both keys are recognised by a single predicate that accepts either decoder shape
  (readline's `sequence` and blessed's `full`), so the front ends cannot drift.
- Every path funnels into `AbortManager.interrupt()`; the front ends only deliver
  keys.

## Where a key's shape is decided

`utils/keys.js` is the one place that knows how a physical key arrives, because the
two decoders disagree about it: readline reports `{ sequence, name, ctrl }` while
blessed reports `{ full, name, ctrl }`, and Escape arrives with no byte at all in
the second case. The predicates therefore never trust a single field.

That module owns the **interrupt pair** (`isEscapeKey`, `isCtrlC`,
`isInterruptKey`) and the **Tab predicates** (`isTabKey`, `isShiftTabKey`) the mode
cycle binds. The two families are deliberately disjoint: a Tab is never an
interrupt and an interrupt is never a Tab, which is what lets both bindings
coexist on the same screen without one swallowing the other. Shift+Tab is
recognised as Tab *and* reported separately (`isShiftTabKey`), so a binding can
walk the mode cycle in either direction from the same predicate.

## States

- **A task is running, no confirmation armed** → ask for confirmation. A second
  interrupt while the confirmation is armed cancels **immediately**, so
  ESC ESC / Ctrl+C Ctrl+C always stop the task.
- **A cancelled task is still unwinding** → further interrupts are ignored until
  the task ends. Otherwise the second press of a double press would be taken as an
  exit request.
- **No task running** → the key is an exit request forwarded to the host, exactly
  once. A later idle interrupt is ignored, not repeated.
- **An exit the host could not deliver** (no prompt armed, e.g. between two
  prompts) does **not** latch the exiting state: ESC/Ctrl+C must not go permanently
  dead.

## Confirmation modes

- `prompt` (line CLI): the readline interface is idle while a task runs, so a
  `Cancel this task? [y/N]` question is asked there.
- `keys` (TUI): the TUI has a single shared input box, so a nested question would
  hijack the pending prompt; the first interrupt prints the instruction and the
  second cancels.

## Who delivers the keys

- **Line CLI**: readline puts stdin in raw mode while a question is pending, so
  `^C` never becomes a process-level SIGINT; readline re-emits it as the interface
  `SIGINT` event, and a listener is kept attached so readline does not close the
  interface instead. Escape arrives as a plain stdin keypress. When readline is
  attached, the raw `^C` byte is *not* handled again, otherwise the confirmation
  would be bypassed.
- **Process-level SIGINT** is kept as a fallback for a non-raw stdin (e.g. the
  detached `start.sh start` run).
- **TUI**: neo-blessed owns stdin, so the manager installs no stdin listener
  (`captureKeys: false`) — a second listener would echo every typed character
  twice — and the screen's key listener calls `interrupt()` instead. The TUI grabs
  the key at program level and locks key dispatch for that single event, so the
  textarea never turns Escape into its own `cancel` and the armed question stays
  armed.
- `dispose()` detaches every listener the manager installed, and the TUI detaches
  its program listener on `close()`.

## Exiting from a prompt

- The line CLI and the TUI each expose `exit()` that settles an **armed** question
  with the `exit` sentinel — the host loop treats it exactly like the user typing
  `exit`. When no question is armed it reports `false` and nothing happens.

## See also

- Implementation: `utils/keys.js`, `app/abort-manager.js`, `app/cli.js`,
  `app/tui.js`, `main.js`
- Proof: `tests/interrupt-controls.test.js`
