<p align="center">
  <img src="moncho.png" alt="Moncho logo" width="200">
</p>

<h1 align="center">Moncho</h1>

<p align="center">
  A terminal coding agent that runs itself: it reads, patches, greps and executes,
  then proves what it changed.
</p>

Moncho is a Node.js agent with a full-screen TUI, a tool sandbox, a token-aware
context window and a project that keeps three realms honest — **code**, **docs** and
**tests**. It talks to any OpenAI-compatible provider (OpenRouter, OpenAI) or Ollama,
chosen entirely through environment variables.

## Install once, then just run it

```bash
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/scripts/install.sh | bash
```

The installer stages a runtime-only payload into `~/.config/moncho-cli` and links
`moncho-cli` onto your `PATH`. It makes no request other than the download and needs
no Node.js on the host: the agent runs in a container.

Then, in any project directory:

```bash
moncho-cli
```

That is the whole flow. A bare `moncho-cli` is `moncho-cli run`, and the first run in
a directory prepares it:

The directory must be a **git repository** — moncho writes inside the workspace, and
the repository is what keeps those files out of your history. It never edits
`.gitignore`: its entries go to `.git/info/exclude`, which is local and never
committed. `--skip-git` is the escape hatch for a deliberate exception, and `status`,
`stop` and `shell` work without a repository so a container can always be inspected
and removed.

1. **The project type is resolved deterministically.** If the directory already has a
   `Dockerfile`, it is **adopted**: the first `FROM` becomes `moncho-agent`, so the
   agent's own runtime (Node, npm, git, patch) sits underneath whatever your app
   needs, and your instructions are kept as written. Otherwise Moncho detects the
   project kind from its markers (`package.json`, `pyproject.toml`, `go.mod`) and
   offers a starter — or you pick one from the menu. Either way the result is a
   `Monchofile`, and it is written once, never overwritten.
2. **The image is built** from that Monchofile. The base image is baked the first time
   and reused while the version is unchanged; the project image is rebuilt whenever
   the Monchofile or the base changes.
3. **The agent starts** in the container, in the directory you are standing in.

Two directories are two containers, two images and two state volumes. Nothing leaks
between projects.

### Two flows, two entry points

Nothing above needs a clone of this repository: the installer is the only thing a user
runs, and `moncho-cli` prepares any directory. Developing *the agent itself* is the
other flow — clone the repo and use `./start.sh run` (or `make dev`), which runs this
checkout with the source bind-mounted. `moncho-cli` recognises the agent's own checkout
by what its manifest declares — never by its layout — and says so instead of preparing
it: the notice names `./start.sh run` and the `MONCHO_AS_PROJECT=1` override. The two
flows can never collide.

## The commands

The lifecycle is the one `start.sh` offers a repository, with the layer a
repository-local script cannot have: the workspace is *whatever directory you invoke
it from*, so every name is derived from `$PWD`.

| Command | What it does |
| ---------------- | ------------------------------------------------------------ |
| `moncho-cli` | Same as `run`: prepare the directory, build, start the agent |
| `moncho-cli run` | Runs the agent in the foreground |
| `moncho-cli start` | Runs detached, then rejoin with `moncho-cli shell` |
| `moncho-cli stop` | Stops and removes this directory's container |
| `moncho-cli shell` | Opens a shell inside the running container |
| `moncho-cli build` | Rebuilds this project's image |
| `moncho-cli status` | Prints what this directory resolves to |

The workspace is bind-mounted at `/app`, so editing a file needs no rebuild. The
agent's own state — sessions, `task.md`, the log — lives in a named volume scoped to
the directory, so removing the container never costs you a conversation and the
checkout stays clean.

Concretely: that volume is mounted at `/app/agent` inside the container, which is why
the state never appears in your project. In the maintainer flow there is no volume at
all — `./start.sh` bind-mounts the checkout, so the state lands in this repository's own
`agent/` directory, which is gitignored for exactly that reason.

## The two rules of a Monchofile

A `Monchofile` is an ordinary Dockerfile with two rules:

1. its first instruction is `FROM moncho-agent` — the agent is already in that base
   image, so never copy it yourself;
2. it declares no `ENTRYPOINT` and no `CMD` — the runner appends the agent's own
   entrypoint after your instructions, so the agent always starts.

An adopted Dockerfile's `ENTRYPOINT`/`CMD` are dropped for that reason (they belong to
the app's own server, not to the agent). Everything else is normal Dockerfile: language
packages, `WORKDIR`, `COPY`, `VOLUME`, `USER`. See `templates/README.md` for the
contract and `demos/README.md` for a run-through.

## Configuration

Environment-driven, and `moncho-cli` reads exactly one file: `./.env.moncho` (or the
path you pass to `--env`). A generic `.env` is deliberately **not** read, so a
project's own credentials never become the agent's provider.

| Variable | Default | Purpose |
| ------------------- | -------------------------------- | ---------------------------------------- |
| `OPENAI_BASE_URL` | `http://host.containers.internal:11434/api/chat` | Provider endpoint (OpenAI-compatible or Ollama) |
| `OPENAI_API_KEY` | *(empty)* | Bearer token; omitted from headers when unset |
| `OPENAI_MODEL` | `qwen3.6:35b-a3b-q4_K_M` | Model id sent with every request |
| `CONTEXT_MAX_LENGTH` | the provider's real total, else `128000` | Working token budget; the override wins but both numbers are shown |
| `PULSE_LIMIT` | `30` | Hard limit of agent model calls between two resets (a completed `task.md` item or a compaction) |
| `THINKING_FILE` | `agent/thinking.md` | Where streaming reasoning is captured, instead of the transcript |
| `LOG_LEVEL` | `info` | Operational-log threshold: `error`, `warn`, `info` (also `warning`/`off`) |
| `LOG_FILE` | `agent/logs/moncho.log` | Where the local log is written; resolved inside the workspace |
| `LOG_MAX_BYTES` | `524288` (512 KiB) | The live file is rotated when the next line would pass this |
| `LOG_MAX_FILES` | `5` | Files kept in the rotation chain, the live one included |

The provider label (`openrouter · deepseek/…`) is derived from the base URL, so
switching providers is a config change and nothing else. The model-call pulse is a
**count kept by the host, not a line sent to the model**: past `PULSE_LIMIT` the host
raises one transient notice and `config/prompt.md` tells the model to stop starting new work
and finish the item. Completing a `task.md` item or running a compaction resets it.

## Using it

Type a prompt and press Enter. A task runs until the model stops asking for tools:

- `exit` quits (and snapshots the session);
- `/help` lists the commands; `/sessions` (alias `/resume`) lists stored conversations
  and continues one, replaying its chunks into the live context;
- `/usage` prints the token breakdown per model for the session;
- `/work on` locks the session to autonomous execution over `task.md`; `/work off`
  releases it and lands on Design;
- **Tab** walks the intent mode (`chat → design → work`), **Shift+Tab** walks it back;
- **ESC** or **Ctrl+C** cancels a running task — press twice to confirm — and quits
  when idle.

In the TUI every tool result is a **collapsible block**, the status bar keeps the
token meter and the working-time counter pinned right, and new output only scrolls the
view when you are already at the bottom. The first row carries the brand line,
`MONCHO (v x.y.z)`.

## Tools

Each tool takes an `intent` parameter: a short phrase saying **why** it is called. The
intent is printed next to the call *and* stored at the head of the result chunk, so
the reason is both visible and part of the model's context.

| Tool | What it does |
| ---------------- | ------------------------------------------------------------- |
| `read_file` | Pages a text file, with line numbers and offset |
| `write_file` | Creates or overwrites a file, verified byte-for-byte |
| `patch_file` | Applies a unified diff, cross-checked before writing |
| `blob` | Fetches several files at once (path, directory or glob) |
| `grep` | Searches contents with optional context lines and globs |
| `run_bash` | One allow-listed command (`ls`, `node`, `git`, …), no shell; a YAML header + stdout, with `head`/`tail` windowing |
| `run_npm` | Allow-listed npm subcommands inside the project |
| `update_task` | Marks a `task.md` item done, ticks a verified plan step, resets the plan |
| `compact_context` | Reports the window, or requests a compaction |

The mode decides which of these a session may use: `chat` is read-only, `design` may
also write `task.md` and `implementation_plan.md`, `work` is unrestricted. A shell is
refused in both narrowed modes, because a shell cannot be scoped to two paths.

## Developing the agent itself

This is the maintainer flow, and the only one that needs a clone. It is how this
checkout has always been run: `./start.sh` builds `moncho` from `./Dockerfile`, reads
`.env` on the host, passes the provider variables through and bind-mounts the source,
so an edit needs no rebuild.

```bash
./start.sh run     # or: ./start.sh start, then ./start.sh shell
make dev           # the same thing
```

Without a container at all:

```bash
npm install
node main.js      # or: npm start
```

Node 22+. There is no build step: the project is plain ES modules. A bare
`node main.js` run has no container, so nothing is sandboxed beyond the tool sandbox.

`make base` bakes the agent image this checkout ships —
`MONCHO_HOME=. ./bin/moncho-cli --build-base --base-only build` — and stops there,
because a checkout carries no project Monchofile by design.

## How it fits together

```
main.js                the host loop: front end, tools, sessions, commands
├── app/               conversation loop, tool batches, context window, TUI
├── api/               provider call (streaming, retries, normalised responses)
├── config/            provider + budget constants, and prompt.md (the system prompt)
├── tools/             the auto-loaded agent tools
├── utils/             token accountancy, compaction, sandbox, patch, sessions, log
├── bin/ scripts/      the container runner and the installer
├── docs/              the behavioural contract (see below)
└── tests/             executable proof that the code honours the docs
```

`agent/` stays out of that tree on purpose: it is gitignored and holds the local state
the app writes as it runs — stored sessions, the tracking files and the rotating log —
never anything that ships.

## The three realms

A behaviour is finished only when a spec under `docs/` describes it and a test under
`tests/` proves it; `tests/docs-realm.test.js` enforces the links, so a missing spec, a
dangling `path#symbol` reference or an unproven source module fails the suite. Start
with `docs/README.md` and `tests/README.md`.

## Development

```bash
npm test              # Node's built-in runner over tests/**/*.test.js
make check-shell      # parse every shipped script, set the executable bits
make probe            # the runner's docker-free logic
make payload          # stage the distribution payload and prove docs/ and tests/ stay out
make base             # bake the agent image from this checkout
```

The suite is self-contained: it stubs the provider over local HTTP and fakes a TTY
with a `PassThrough` stream, so it needs no network and no pty. Ad-hoc exploration
scripts live in `agent/` (gitignored and disposable) and are deleted unless they stay
genuinely reusable; anything that must run on every change is a test instead.
