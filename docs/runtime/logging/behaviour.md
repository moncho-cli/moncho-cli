# runtime/logging — the operational log

## What it is

The harness keeps a **local, rotating log file** of what it did — the events around
the conversation, not the conversation itself:

```
2026-02-14T10:30:00.211Z INFO  [startup] moncho ollama · qwen3.6 starting; log threshold info {"file":"agent/logs/moncho.log","maxBytes":524288,"maxFiles":5}
2026-02-14T10:31:02.004Z WARN  [provider] attempt 1/3 failed; retrying in 5000ms {"name":"Error","message":"HTTP error! status: 502","stack":"Error: HTTP error! status: 502\n    at …"}
2026-02-14T10:31:09.870Z ERROR [session] could not save agent/sessions/…json {"name":"ErrorIOError","message":"EACCES…"}
```

The backlog entry this implements:

> we need to save logs in some internal local log file that gets auto rotated by this
> same deterministic code, so we can find errors and stuff. the usual 3 leves: error,
> warning, info and a level threshold via environment

## Why a log at all, when sessions exist

The session file (`docs/runtime/session-store`) already stores every chunk the model
saw — but it answers *what was said*, never *what the harness did*. The two questions
an operator asks after a bad run are:

- why did that call take three attempts? — a retried attempt is a **transient notice**
  on screen (`docs/interface/notice-overlay`) and leaves nothing behind once it
  expires;
- why is this session shorter than expected? — a failed save prints one transcript
  line that scrolls away.

So the log is deliberately **not** a second transcript: it records events, and a line
carries a scope (`provider`, `session`, `tool`, `logger`, `startup`), a flattened
message and optional structured details. No chunk is ever copied into it.

## The three levels and the threshold

`utils/logger.js` knows exactly three levels, in the order a threshold walks them:

| Level | Rank | Used for |
| ----- | ---- | -------- |
| `error` | 0 | Something that ended the work: a provider call that gave up, a session that could not be saved, a fatal startup error. |
| `warn` | 1 | Something recovered from: a retried attempt, a tool that threw. |
| `info` | 2 | The narrative: startup, a rotation announcing itself. |

A line is written when its rank is **at or below** the threshold, so `LOG_LEVEL=warn`
keeps warnings and errors and drops info. `normalizeLogLevel()` is deliberately
forgiving in exactly one direction: it accepts the full spelling **`warning`** (the
spelling the backlog itself uses) as `warn`, and `off` / `none` / `disabled` as a
silent threshold. Anything else that is not a known level falls back to `info`, so a
typo cannot silently disable the log.

`silent` is the one threshold under which nothing at all is written — not even an
error — and, being a level rather than a flag, `enabled()` answers `false` for every
level under it.

## Configuration

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `LOG_LEVEL` | `info` | The threshold (`error`, `warn`, `info`, or `warning`/`off`). |
| `LOG_FILE` | `agent/logs/moncho.log` | Project-relative path of the live file. |
| `LOG_MAX_BYTES` | `524288` (512 KiB) | Rotate when the next line would pass this. |
| `LOG_MAX_FILES` | `5` | Files kept in the chain, the live one included. |

The defaults live in `config/constants.js`, next to the other environment-driven
settings, and the file defaults into the gitignored `agent/` tree for the same reason
the sessions do: an operational log describes the workspace it was written in, so it
belongs with that workspace and must never leak into a commit.

## Rotation is the same code, and it is deterministic

There is no timer and no external `logrotate`. Rotation happens **inside the write
that would have overflowed**, so the trigger and the shift can never disagree:

1. the next line is measured (`Buffer.byteLength`, not `String.length`, because the
   bytes on disk are what the budget is about);
2. if `existing + bytes > maxBytes` the chain is shifted;
3. the new line is appended to the fresh file.

`rotateLog()` is the whole rule, and it is a pure function of the directory: the file
becomes `<file>.1`, `<file>.2` shifts to `<file>.3`, the oldest is dropped, and at
most `maxFiles` files exist in total — **the live file counts**, so `LOG_MAX_FILES=5`
means the live file plus four archives. Two consequences are worth stating:

- an **empty file is never rotated**, so a single line larger than the whole budget
  still lands instead of rotating on every write and keeping nothing;
- `LOG_MAX_FILES=1` *restarts* the log (the file is deleted) rather than archiving it,
  because a chain of one archive would double the budget rather than respect it.

The rotation announces itself as an `info` line scoped to `logger`, so
reading the file answers why the history starts where it does.

## It never costs the turn it describes

Writing a log line must not be able to break the session it is describing. Every
failure — a path the sandbox refuses, a read-only directory, a full disk — is caught
inside `createLogger()` and recorded in `logger.getFailure()` (the *why* of the last
line that did not land). `logEvent()` catches one layer further up, around the
registered logger itself, so a broken sink still cannot throw into a tool call or a
provider retry.

The path goes through `resolveProjectPath()` — the same sandbox every file tool uses —
so `LOG_FILE` cannot be pointed outside the working directory.

## How the deep modules reach it

The module is split in two along one line: `utils/log-record.js` is the **record**
half — what a level is, what the threshold admits, and the exact bytes of one line —
and touches no filesystem, while `utils/logger.js` is the **sink** half — where the
line goes, when the file rotates, and why a write cannot throw. `utils/logger.js`
re-exports the record rules, so every call site and every spec keeps naming one file.

A tool result, a turn and a provider retry are all deep inside the harness, and none
of them owns a logger. They call `logEvent(level, scope, message, details)` from
`utils/logger.js`, which writes through the logger registered in the host registry
(`utils/host.js#registerLogger`) by `main.js` at **module scope**, before the session
is wired — so even a fatal startup failure is recorded.

With **no** logger registered (a unit test, a bare tool call) `logEvent()` is a silent
no-op and creates no file: the suites stay free of side effects, and a module cannot
start writing logs behind the caller's back.

## What is recorded today

| Scope | Level | Event | Site |
| ----- | ----- | ----- | ---- |
| `startup` | `error` | A fatal error that stopped the session from starting | `main.js` |
| `session` | `error` | A session file that could not be saved | `main.js` |
| `provider` | `error` | `prompt.md` could not be read, so the agent answers without its prompt | `api/ollama.js#loadSystemPrompt` |
| `provider` | `error` | The last attempt failed and the call is given up | `api/ollama.js#callOllama` |
| `provider` | `warn` | An attempt failed and is being retried | `api/ollama.js#callOllama` |
| `provider` | `warn` | An empty response; the turn retries it | `app/turn-runner.js#runTurn` |
| `provider` | `info` | The call was aborted by the user (ESC / Ctrl+C) | `api/ollama.js#callOllama`, `app/turn-runner.js#runTurn` |
| `provider` | `error` | The failure that ended the turn | `app/turn-runner.js#runTurn` |
| `tool` | `warn` | A tool threw; the chunk only carries its message, the log the stack | `app/tool-batch.js#dispatchToolCalls` |
| `logger` | `info` | A rotation, naming the file and the budget that caused it | `utils/logger.js#createLogger` |

`utils/logger.js` also exports `formatLogLine()`, `normalizeLogLevel()`,
`normalizeLogLimit()`, `serializeLogError()` and `rotateLog()` separately, because
each is a rule worth proving on its own.

## Proof

Two suites keep the two halves apart, mirroring the module's own split:

- `tests/logging.test.js` — the logger **as a value**: the level set and the aliases,
  the threshold from `config/constants.js`, the shape of a line, the rotation chain
  and its budget, and the fact that neither a broken sandbox nor a broken writer can
  throw out of a write;
- `tests/logging-sites.test.js` — the logger **as wiring**: the turn-ending provider
  failure and the throwing tool are the events the real call sites actually record,
  the outcome the caller sees is unchanged, and `LOG_FILE` cannot escape the project.

<!--
implementation: utils/logger.js, utils/log-record.js, config/constants.js, utils/host.js, main.js,
api/ollama.js, app/turn-runner.js, app/tool-batch.js, start.sh, .env.example
-->
