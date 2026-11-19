# Monchofile templates

One file per project kind. `moncho-cli` uses one when a project has no `Monchofile`,
copies it to `./Monchofile` (and the matching `.dockerignore.<kind>` to
`./.dockerignore`), and never overwrites a file that already exists.

| Template | For |
| -------- | --- |
| `Monchofile.node` | Node.js / JavaScript repositories |
| `Monchofile.python` | Python repositories |
| `Monchofile.go` | Go repositories |
| `Monchofile.minimal` | anything else, or a repository the agent only reads |

## What happens on a first run

The order matters, and it is the order the user expects.

The one directory none of this applies to is the agent's own checkout. It carries a
`Dockerfile` that belongs to the maintainer's loop (`./start.sh`), so `moncho-cli`
recognises it by its manifest — never by its layout — and stops with a pointer to
`./start.sh run` instead of adopting the file the agent itself is developed with.

1. **A `Dockerfile` in the project root is adopted.** It already describes the app's
   own tooling, so it is the most specific answer available: its first `FROM` becomes
   `moncho-agent` and its instructions are kept as written. The original file is left
   untouched; the result is written as `Monchofile`.
2. **Otherwise the project kind is detected** from `package.json`, `pyproject.toml` or
   `go.mod`, and the matching starter is offered. Empty input takes the detected one,
   `q` prints the authoring guide, and nothing is written without an answer.
3. **Nothing is ever overwritten.** A `Monchofile` that already exists is the user's
   file, whatever it says.

Adoption refuses two shapes rather than guessing, because neither can start the agent:
a **multi-stage** Dockerfile (the final stage is what ships, and the agent may not be
in it) and a base image the agent's Alpine runtime cannot replace (only `node:*alpine`
bases are accepted; a Debian base would break the appended instructions).

## The contract, in two rules

1. The **first instruction is `FROM moncho-agent`**. The agent runtime is already in
   that base image, so a Monchofile never copies it. `moncho-cli` rewrites the tag to
   the installed version, so a Monchofile cannot pin a version that is not on the
   machine.
2. **No `ENTRYPOINT`, no `CMD`.** `moncho-cli` appends the agent's own entrypoint after
   your instructions, which is what makes it impossible to override; a `CMD` would be
   handed to that entrypoint as arguments. A Monchofile that declares either is refused.

Everything else is an ordinary Dockerfile. See `agent/tmp/distributing.md` for the full
spec, `moncho-cli help` for the commands, and `demos/README.md` for a run-through.
