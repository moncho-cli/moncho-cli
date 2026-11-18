# Agent — command sandbox (run_bash / run_npm)

The agent can run commands, but only a small, explicitly allow-listed palette and
never through a shell. This spec fixes what is runnable, what is rejected, and how
results are reported.

## run_bash

- **No shell.** The command line is tokenised in-process and executed with
  `execFileSync`, so `;`, `|`, `&&`, `>`, backticks, `$(…)`, braces, brackets,
  backslashes, `!`, newlines, tabs and unquoted glob characters are rejected with
  `SHELL_METACHARACTER`. Quoted segments are exempted from that scan, which keeps
  quoted glob patterns usable (`ls "tests/**/*.test.js"`).
- **Only the first token is checked** against the allow-list. A binary outside it
  is `COMMAND_NOT_ALLOWED`; the approved list is echoed in the message.
- Quoting is honoured by the tokeniser (single and double); an unterminated quote
  is `UNBALANCED_QUOTE`, and an empty command is `EMPTY_COMMAND`.
- `cwd` is resolved through the same path sandbox as every other file operation,
  so a command cannot be pointed outside the project.
- The default timeout is 60s; `timeoutMs` overrides it.

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

## See also

- Implementation: `tools/run_bash.js`, `tools/run_npm.js`, `utils/command-output.js`,
  `config/constants.js`
- Proof: `tests/harness-tools.test.js`, `tests/command-output-window.test.js`
