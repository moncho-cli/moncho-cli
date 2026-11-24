# The headless one-shot: `--exec`, `--prompt`, `--turns` and `--mode`

The agent has always had two ways to run: a pty, which gets the TUI, and no pty, which
gets the line CLI. Both end up *asking* for a prompt, and both end when the user types
`exit` — so neither can be driven by another program. Anything that wanted to give the
agent one task, let it work unattended and read what it changed had to fake a terminal,
and faking a terminal is how a harness starts measuring its own plumbing instead of the
agent.

These flags close that gap. They are a **general capability of the agent**, not a
hook for any particular caller: nothing here knows what is driving it, and there is no
example, benchmark or project name anywhere in this document, the module or the tests.

## The flags

| Flag | Meaning |
| --- | --- |
| `--exec <file>` | The prompt is this file's whole contents. Run it, then stop. |
| `--exec -` | The prompt is whatever was piped to stdin. Run it, then stop. |
| `--prompt <text>` | The prompt is this argument, verbatim. Run it, then stop. |
| `--turns <n>` | Take at most `n` turns in this process. |
| `--mode <name>` | Start the session in this mode instead of `DEFAULT_MODE`. |

A run is **headless** when any of the three prompt sources names one, and also when only a
turn budget is given. Every source answers the same question for the same reason — there is
no keyboard left to ask — and each one ends the process through the ordinary `exit` route.

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

### `--exec -`

`-` instead of a path means **stdin**: `moncho-cli run --exec - < task.md`, or
`git show HEAD:task.md | moncho-cli run --exec -`. It is written this way, rather than as a
fourth top-level rule, because in the line CLI stdin is also the *keyboard* — so a process
that reads its prompt from stdin is a process that cannot also ask a question, which is
exactly what `--exec` already means. The runner forwards stdin whenever there is no tty
(`bin/lib/container.sh`), so the pipe reaches the agent.

**A terminal is refused, not read.** A pipe ends; a tty does not. Reading a terminal blocks
until the user types Ctrl+D, which for a one-shot run is a hang: the process sits there with
no prompt on screen saying what it is waiting for. So a terminal stdin is refused up front —
before the session is wired, beside the other argument errors — with a message that names the
mistake (the caller meant to pipe).

The read itself is asynchronous and happens **once at startup**, so the process is never
parked waiting on a stream in the middle of a turn and the event loop stays live.
`utils/stdin-prompt.js#readStdinPrompt` owns it, taking the stream and its tty-ness as
parameters so the contract is proved without a terminal; the bytes it returns are then handed
to the prompt source, which is why the source stays synchronous.

### `--prompt <text>`

The argument itself is the prompt, **verbatim**: not trimmed, not re-joined, not split. It
exists for what a shell makes easy and a file makes awkward — one line of prose — and it is
never a placeholder for a shell's own quoting, so a multi-line argument survives as it was
written.

Giving two prompt sources in one run (`--exec` and `--prompt`) is a **contradiction, not a
precedence question**: the run has one turn and one prompt, so there is no rule that could
pick between them. It is reported rather than resolved, because either resolution would
silently discard what the caller believed was in force. Repeating the *same* source keeps
its last value, as every other flag does.

### `--turns <n>`

Bounds how many turns one process may take. `n` must be a positive whole number: zero
turns is not a run, and a negative one is a mistake rather than a very small run.

A turn budget is meaningful **without** a named prompt too — a session with a terminal may
be asked to stop by itself after three turns — but it composes with one as an *upper bound*.
A named prompt is one prompt and neither a file nor a pipe is a queue: re-reading it would
repeat the same task rather than continue it. So a named prompt bounds the process to one
turn whatever else was asked for.

### `--mode <name>`

Sets the mode the session opens in (`docs/interface/modes`). This is startup state, the
same thing `Tab` changes while running, and the name is validated by the ordinary mode
normaliser — an unrecognised name resolves the way an unrecognised name always does
rather than being refused as a new failure mode.

## Refusals

An unknown argument, a missing value, a non-positive `--turns`, and **two prompt sources at
once** are all **errors**, reported before the session starts. Not warnings, and not ignored.

The reason is that each one is a silently wrong run rather than a cosmetic problem. A
caller who typed `--turn 5` has asked for a bounded run and would otherwise get an
unbounded one; a caller who typed `--exec` with nothing after it has asked for a prompt
and would otherwise get the keyboard. A benchmark that ran the wrong budget and reported
a number would be worse than one that refused to start, because nothing about the number
would show the mistake.

A flag is never consumed as another flag's value: `--exec --turns 3` reports a missing
path for `--exec` *and* a valid `--turns`, rather than reading `--turns` as a filename.
Two prompt sources is the same kind of mistake from the other side — `--exec task.md
--prompt "do it"` names two different tasks for one turn — so it is refused rather than
resolved by a precedence rule nobody could predict.

## Shape

`utils/run-flags.js` is pure and terminal-free. The argv array is passed in, no disk is
touched, and the answer is a plain object — so the whole contract is proved by unit tests
with no pty, no provider and no sandbox. The functions that do read (`createFilePrompt`,
`createPromptSource`) take their `readFile` and `readStdin` injected for the same reason,
which is also what keeps a suite from hanging on the real stdin.

The wiring is `main.js`: it parses the flags once, **reads the pipe** when `--exec -` asks for
it (refusing a terminal), builds **one** prompt source through
`createPromptSource({ exec, prompt, readFile, readStdin })`, and passes it and the turn
budget to `runSessionLoop`. The loop never learns which of the three sources it got — it
already accepted a prompt from `app/message-queue.js#nextPrompt`, and a source is simply
another one of the same thing.

Where a bad source is reported is deliberately one rule, not two. A **file** and an
**argument** are refused on the source's *first call* — never at construction — because a
throw there would crash the wiring before a session exists to report it, and the first call is
where every other bad-input failure in this module already lands. **stdin** is the exception
and it is the earlier one, because it is the only source that has to be drained before the
loop can safely exist: it is read at startup, so a terminal (which would never end) and an
empty pipe are both reported beside the argument errors. What does not change is that no
failure is a stack trace and none of them is ignored.

The runner (`bin/moncho-cli`, `bin/lib/container.sh`) is a courier: it forwards `--prompt`
verbatim and counts it — like `--exec` and `--turns` — as a reason to turn the tty off, so a
headless run never paints a screen into whatever captured its output.

@see docs/runtime/startup-wiring, docs/interface/modes, docs/interface/line-cli
