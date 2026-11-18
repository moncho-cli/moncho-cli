# Agent — command sandbox (run_bash / run_npm)

The agent can run commands, but only a small, explicitly allow-listed palette and
never through a shell. This spec fixes what is runnable, what is rejected, and how
failures are reported.

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
- A non-zero exit is reported as JSON `status: "error"` with `code`
  `COMMAND_FAILED` plus the captured `stdout`/`stderr`; a timeout is `TIMEOUT`
  with the partial output. Success returns the trimmed stdout, or `(no output)`.
- The default timeout is 60s; `timeoutMs` overrides it.

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

- Implementation: `tools/run_bash.js`, `tools/run_npm.js`, `config/constants.js`
- Proof: `tests/harness-tools.test.js`
