# The headless one-shot: `--exec`, `--turns` and `--mode`

The agent has always had two ways to run: a pty, which gets the TUI, and no pty, which
gets the line CLI. Both end up *asking* for a prompt, and both end when the user types
`exit` — so neither can be driven by another program. Anything that wanted to give the
agent one task, let it work unattended and read what it changed had to fake a terminal,
and faking a terminal is how a harness starts measuring its own plumbing instead of the
agent.

These three flags close that gap. They are a **general capability of the agent**, not a
hook for any particular caller: nothing here knows what is driving it, and there is no
example, benchmark or project name anywhere in this document, the module or the tests.

## The flags

| Flag | Meaning |
| --- | --- |
| `--exec <file>` | The prompt is this file's whole contents. Run it, then stop. |
| `--turns <n>` | Take at most `n` turns in this process. |
| `--mode <name>` | Start the session in this mode instead of `DEFAULT_MODE`. |

### `--exec <file>`

The file's bytes **verbatim** are the prompt. Not split into lines, not trimmed, not
re-joined from shell arguments: a task is prose, and the newlines in it are part of it.
A prompt assembled by a shell would lose blank lines and mangle quoting, and the task the
model sees would then differ from the task the caller wrote.

A named prompt makes the process non-interactive. There is no question left to ask, so
the loop runs its turn and leaves — the same route `exit` takes, through the same save.
Nothing waits for a keystroke.

An empty or blank file is refused rather than sent: an empty prompt is not a task, and
sending it would spend a turn on nothing.

### `--turns <n>`

Bounds how many turns one process may take. `n` must be a positive whole number: zero
turns is not a run, and a negative one is a mistake rather than a very small run.

A turn budget is meaningful **without** `--exec` too — a session with a terminal may be
asked to stop by itself after three turns — but it composes with it as an *upper bound*.
`--exec` names one prompt and a file is not a queue: re-reading it would repeat the same
task rather than continue it. So `--exec` bounds the process to one turn whatever else
was asked for.

### `--mode <name>`

Sets the mode the session opens in (`docs/interface/modes`). This is startup state, the
same thing `Tab` changes while running, and the name is validated by the ordinary mode
normaliser — an unrecognised name resolves the way an unrecognised name always does
rather than being refused as a new failure mode.

## Refusals

An unknown argument, a missing value, and a non-positive `--turns` are all **errors**,
reported before the session starts. Not warnings, and not ignored.

The reason is that each one is a silently wrong run rather than a cosmetic problem. A
caller who typed `--turn 5` has asked for a bounded run and would otherwise get an
unbounded one; a caller who typed `--exec` with nothing after it has asked for a prompt
and would otherwise get the keyboard. A benchmark that ran the wrong budget and reported
a number would be worse than one that refused to start, because nothing about the number
would show the mistake.

A flag is never consumed as another flag's value: `--exec --turns 3` reports a missing
path for `--exec` *and* a valid `--turns`, rather than reading `--turns` as a filename.

## Shape

`utils/run-flags.js` is pure and terminal-free. The argv array is passed in, no disk is
touched, and the answer is a plain object — so the whole contract is proved by unit tests
with no pty, no provider and no sandbox. The one function that does read (`createFilePrompt`)
takes its `readFile` injected for the same reason.

The wiring is `main.js`: it parses the flags once, and passes the bounded prompt source
and the turn budget to `runSessionLoop`. The loop does not know where a prompt came from —
it already accepted one from `app/message-queue.js#nextPrompt`, and a file is simply
another source of the same thing.

@see docs/runtime/startup-wiring, docs/interface/modes, docs/interface/line-cli
