# Interface — the line CLI

Without a pty (the detached `./start.sh start` run, a piped stdin, or any non-TTY
stdout) the agent falls back to a plain line-based chat on readline. This spec
fixes that surface; the implementation is linked below.

## The surface

- `createCLI()` returns `{ rl, question, exit, close }`.
- `question(prompt)` arms a single pending question and resolves with the user's
  answer. Only one is pending at a time, which is what makes `exit()` meaningful.
- `exit()` settles an **armed** question with the `exit` sentinel — the host loop
  treats it exactly like the user typing `exit` — and returns `true`. When nothing
  is armed it returns `false` and changes nothing, so the caller can tell the
  difference and avoid latching a dead state (see `docs/interface/interrupt-controls`).
- `close()` releases the readline interface.

## Relationship to the TUI

- The TUI deliberately exposes a `createCLI()`-compatible question/exit surface, so
  the host loop is front-end agnostic: it asks `cli.question(...)` and reacts to the
  `exit` sentinel the same way either way.
- Choosing between them is a single decision at startup: a TTY gives the TUI,
  otherwise the line CLI. No other module needs to know which one is active.

## Rendering

- In the line CLI, `log()` is `console.log`, so tool results, intents, context
  usage and compaction notices are printed as plain lines. There is no sanitising
  step because nothing is re-rendered through a terminal widget.

## See also

- Implementation: `app/cli.js`, `main.js`
- Spec of the key handling: `docs/interface/interrupt-controls`
- Proof: `tests/interrupt-controls.test.js`
