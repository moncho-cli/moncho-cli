# Agent — command sandbox (run_bash / run_npm)

The agent can run commands, but only a small, explicitly allow-listed palette and
never through a shell. This spec fixes what is runnable, what is rejected, and how
results are reported.

## run_bash

- **No shell.** The command line is tokenised in-process and executed with `spawn`
  (`utils/command-runner.js`), so `;`, `|`, `&&`, `>`, backticks, `$(…)`, braces,
  brackets, backslashes, `!`, newlines, tabs and unquoted glob characters are rejected
  with `SHELL_METACHARACTER`. Quoted segments are exempted from that scan, which keeps
  quoted glob patterns usable (`ls "tests/**/*.test.js"`).
- **Only the first token is checked** against the allow-list. A binary outside it
  is `COMMAND_NOT_ALLOWED`; the approved list is echoed in the message.
- Quoting is honoured by the tokeniser (single and double); an unterminated quote
  is `UNBALANCED_QUOTE`, and an empty command is `EMPTY_COMMAND`.
- `cwd` is resolved through the same path sandbox as every other file operation,
  so a command cannot be pointed outside the project.
- The default timeout is 60s; `timeoutMs` overrides it.

## A command can never freeze the UI

A command runs **asynchronously, with no terminal and no prompt**: the run is a promise,
so the event loop keeps turning while the child does.

This is the whole reason `utils/command-runner.js` exists instead of `execFileSync`. The
synchronous call did not return until the child exited, so a child that opened a prompt —
a `git` credential ask, an `ssh` password, a pager waiting for keys — stopped the event
loop dead. No key handler can run without the loop, so **Ctrl+C never reached the abort
manager and the UI froze**, escapable only by killing the process. Three properties make
that impossible by construction, and they are the contract, not an implementation note:

- **the call is a promise.** Key handling, repaints and cancellation keep working while a
  command runs. A long command is slow, never stuck.
- **the child is given no terminal.** stdin is `/dev/null`, so a child that reads gets
  end-of-file at once: a prompt becomes an immediate result, never a wait for a person who
  cannot be reached. The environment makes the well-known offenders fail fast on top of
  that (`GIT_TERMINAL_PROMPT=0`, an askpass that only echoes, `ssh -o BatchMode=yes`,
  `PAGER=cat`, `npm_config_yes`) — `childEnvironment()` is that set, and a command that
  needs a human is a command the harness cannot run.
- **cancellation kills the child.** The tool receives the running task's `AbortSignal`
  (`utils/tool-schema.js#defineTool` forwards it, `app/tool-batch.js` supplies it) and the
  runner uses it to `SIGTERM` the child, then `SIGKILL` it after `KILL_GRACE_MS`. Without
  the signal, cancelling would stop only the *wait*, leaving the process running.

A run that cannot proceed is a structured result, never a hang: `CANCELLED` when the task
was cancelled, `TIMEOUT` when it exceeded `timeoutMs`, and `COMMAND_FAILED` with the reason
when the binary could not be started at all. The runner itself never rejects — every
outcome resolves to the same result shape, so no spawn failure is swallowed.

## The output document

A **successful** command answers as a *document*: a YAML header, a `---` delimiter
line, then the stdout verbatim. The header is a small, stable set of plain
`key: value` lines — `status`, `command`, `cwd`, `exit_code`, `lines`, `shown`,
`truncated`, `mode` and the requested window — so the payload can be read without
parsing JSON. A value YAML would read as something else (a number, a keyword, a
colon, an empty string) is double-quoted; a plain word or path stays plain. An
empty stdout is reported as `(no output)` after the delimiter.

- **`head` / `tail` window the stdout** so a long listing can be read from either
  end without a pipe: `head: 3` shows the first three lines, `tail: 2` the last
  two. `mode` is `all`, `head` or `tail`; `lines` is the total and `shown` how many
  are in the payload, so a truncated document is never mistaken for a complete one.
- The two are **mutually exclusive**: asking for both is `INVALID_RANGE`, and so is
  a count that is not a whole number of at least one line. The command is not run
  in that case.
- **No window asked for is not "no limit".** An output longer than
  `DEFAULT_WINDOW_LINES` comes back as its **tail** — the verdict of a test run or a
  build is at the end — with `mode: default`, which says the choice was made for the
  caller rather than by it. An unbounded output is never handed over whole.
- **A truncated document carries the way back.** `capture` is a handle to the whole
  stream, still in memory (`docs/agent/command-capture`), `range` is the 1-based
  lines the payload covers, and `hint` names the tool that pages or scans it. A
  truncation without a way back would be a dead end: the model knows what it asked,
  so it can page the head, the tail, or scan for the line that failed.

A **failing** command keeps the JSON diagnostic envelope, because a stable
machine-readable `code` matters more than a pretty one: a non-zero exit is
`COMMAND_FAILED` and a timeout is `TIMEOUT`, both `status: "error"` with the
captured `stdout`/`stderr` attached. Its stdout is windowed by the same `head`/`tail`
rule and reports `stdoutLines`/`stdoutShown`/`stdoutTruncated`/`mode`, so a long
failing output is still readable end-first.

## run_npm

- Only the allow-listed npm subcommands run (`install`, `i`, `uninstall`,
  `remove`, `ci`, `ls`, `list`, `view`, `outdated`, `explain`, `test`, `run`,
  `pkg`, `dedupe`); anything else is `SUBCOMMAND_NOT_ALLOWED`. Empty arguments are
  `EMPTY_ARGS`.
- The same shell-metacharacter rejection applies to every argument, and a set of
  flags is refused outright (`ARG_NOT_ALLOWED`): global installs (`-g`,
  `--global`), `--prefix=…` and other flags that would place packages outside the
  project.
- Arguments may be passed as a string (tokenised with quoting) or as an array.
- Failure is reported structurally: a non-zero npm exit is `NPM_FAILED`, a
  timeout is `TIMEOUT`, both with `status: "error"` and the npm output attached.
- A **successful** npm run answers with the *same* document `run_bash` does — the YAML
  header, the `---` delimiter, the bounded window and the capture handle — because
  `npm test` is the command whose output most needs it. A failing one keeps its JSON
  envelope, with both streams windowed and the same handle when something was cut.

## See also

- Implementation: `tools/run_bash.js`, `tools/run_npm.js`, `utils/command-runner.js`,
  `utils/command-output.js`, `config/constants.js`
- Where the rest of a windowed output goes: `docs/agent/command-capture`
- How a tool receives the signal that kills its child: `docs/agent/tool-call-contract`
- Proof: `tests/harness-tools.test.js`, `tests/command-output-window.test.js`,
  `tests/command-runner.test.js`
