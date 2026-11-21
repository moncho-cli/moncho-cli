# Using Moncho

This is the user's document: install it, run it in a project, configure it, and read
what the screen tells you. [README.md](README.md) is the front page,
[REQUIREMENTS.md](REQUIREMENTS.md) lists what the host must provide, and
[CONTRIBUTING.md](CONTRIBUTING.md) covers changing the agent itself.

## What it is

Moncho is a terminal coding agent. It runs in a container, so the shell it uses and
the packages it installs are inside that container rather than on your machine. It
talks to an OpenAI-compatible provider or to Ollama, chosen by environment variables.

The agent's own state — sessions, the task checklist, the operational log — lives in a
named volume scoped to the directory you invoked it from. Your working tree stays
clean: nothing is written into the repository, and nothing is added to `.gitignore`.

## Install

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/scripts/install.sh | bash
```

The installer stages the payload under `~/.config/moncho-cli`, links `moncho-cli` into
`~/.local/bin`, and prints the `PATH` line to add if that directory is not already on
it. It never edits your shell profile.

### macOS

The same command works on macOS with Docker Desktop installed:

```bash
curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/scripts/install.sh | bash
```

Two macOS details matter:

- **The container runtime.** Docker Desktop provides the `docker` CLI and the daemon.
  Colima works too, as long as `docker info` succeeds. The installer checks this before
  it downloads anything, so a missing daemon fails immediately and cleanly.
- **The uid mapping.** The runner starts the container as your host uid, so files the
  agent writes are owned by you and not by root. That is why no `sudo` is needed
  anywhere in this flow.

The scripts are `bash` 3.2-compatible for the macOS system shell; nothing requires
bash 4 or 5.

### What the installer does, in order

1. Checks for `curl`, `tar` and a reachable Docker daemon.
2. Downloads the release tarball into a temporary directory.
3. Verifies the checksum when the release publishes one.
4. Extracts into a staging directory and refuses to install if `docs/` or `tests/` came
   along — the payload is runtime-only.
5. Swaps the staged tree into place and links the binary.

Nothing is executed straight off the wire, so a truncated download cannot leave a
half-installed tree behind.

### Installer options

| Option | Effect |
| ------ | ------ |
| `--ref <tag>` | Install a specific release instead of `main` |
| `--dir <path>` | Install somewhere other than `~/.config/moncho-cli` |
| `--no-symlink` | Do not link `moncho-cli` into `~/.local/bin` |
| `--force` | Replace an existing installation |
| `--uninstall` | Remove the installation and the symlink |
| `-h`, `--help` | The installer's own help |

The same three knobs are available as environment variables: `MONCHO_REPO`,
`MONCHO_REF` and `MONCHO_HOME`.

## First run

```bash
cd ~/code/some-project
moncho-cli
```

A bare invocation means `moncho-cli run`. The first time in a directory it prepares it:

1. **The project type is resolved.** If the directory already has a `Dockerfile`, it is
   adopted: its first `FROM` is rewritten to `moncho-agent`, so the agent's runtime sits
   underneath your app's. Otherwise the kind is detected from `package.json`,
   `pyproject.toml` or `go.mod`, and a starter is offered. Empty input takes the
   detected one; `--yes` takes the default without asking.
2. **The base image is baked** if it is missing, from the installed payload.
3. **The project image is built** from the `Monchofile`.
4. **The agent starts** in the foreground with your workspace mounted at `/app`.

The directory must be a git repository. Moncho writes `.moncho/` inside the workspace,
and the repository is what keeps those files out of your history — the exclusion goes
into `.git/info/exclude`, never into `.gitignore`. `--skip-git` is the escape hatch for
a deliberate exception; `status`, `stop` and `shell` work without a repository so a
container can always be inspected and removed.

## Commands

| Command | What it does |
| ------- | ------------ |
| `moncho-cli` | Same as `run` |
| `moncho-cli run` | Run the agent in the foreground |
| `moncho-cli start` | Run detached, then rejoin with `shell` |
| `moncho-cli stop` | Stop and remove this directory's container |
| `moncho-cli shell` | Open a shell inside the running container |
| `moncho-cli build` | Rebuild this project's image |
| `moncho-cli status` | Print what this directory resolves to |
| `moncho-cli help` | The command's own help |

## Options

| Option | Effect |
| ------ | ------ |
| `--env <path>` | Read this env file instead of `./.env.moncho` |
| `--state-in-repo` | Keep the state in `./agent` instead of a named volume |
| `--do-not-mount` | No bind mount: `/app` is what the image contains |
| `--copy-files` | Copy the workspace into the image at build time |
| `--sync-files` | Copy `/app` back into this directory when the run ends (`agent/` is always excluded) |
| `--sync-delete` | Let `--sync-files` delete host files (needs `rsync`) |
| `--rebuild` | Rebuild the project image |
| `--build-base` | Repaint the agent base image even when it exists |
| `--base-only` | With `build`: stop after the base image |
| `--skip-git` | Work here without a git repository |
| `--yes`, `-y` | Take the default template instead of asking |

`--do-not-mount` and `--copy-files` are mutually exclusive. `--sync-files` requires one
of them, because a bind mount already writes straight through.

## Configuration

Moncho reads **one** env file: `./.env.moncho`, or whatever `--env` points at. A generic
`.env` is deliberately ignored, so a project's own credentials never become the agent's
provider. The file is sourced as shell, so quoting and comments behave the way you
expect, and the values travel into the container as `-e NAME` — never as `-e NAME=value`
— so a key does not appear in the host process list.

Start from the example:

```bash
cp .env.moncho.example .env.moncho
```

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `OPENAI_BASE_URL` | `http://host.containers.internal:11434/api/chat` | Provider endpoint |
| `OPENAI_API_KEY` | — | Bearer token; omit for Ollama |
| `OPENAI_MODEL` | `qwen3.6:35b` | Model name |
| `CONTEXT_MAX_LENGTH` | the provider's real total | Context budget override |
| `COMPACTION_OLD_RATIO` | `0.7` | Share of the window summarised on compaction (`0.7`, `70` or `70%`) |
| `PULSE_LIMIT` | `30` | Model calls before the pulse notice |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `off` |
| `LOG_MAX_BYTES` | `524288` | Rotation threshold |
| `LOG_MAX_FILES` | `3` | Rotation chain length |
| `TZ` | the host's zone | Passed into the container |

### Reaching a host Ollama from the container

The container reaches the host through the gateway the runner adds:

```bash
OPENAI_BASE_URL=http://host.docker.internal:11434/api/chat
OPENAI_MODEL=qwen3.6:35b
```

On a Linux host with Docker Desktop, `host.docker.internal` resolves through the
`--add-host` flag the runner passes. A provider on the open internet needs no gateway at
all.

## Using the agent

Type a prompt and press Enter. A task runs until the model stops asking for tools.

The session opens in **`work`** mode, where the work happens: talk it through and the
agent acts on what you say. **Tab** narrows the intent mode when you want to —
`chat` → `design` → `work` — and **Shift+Tab** walks back. `chat` is read-only (no
writer, no shell), `design` also writes the two tracking files, `work` is unrestricted.

| Command | What it does |
| ------- | ------------ |
| `/help` | List the commands |
| `/sessions` | List stored conversations, or resume one |
| `/usage` | Print the token breakdown for the session |
| `exit` | Quit |

**ESC** or **Ctrl+C** cancels a running task; press twice to confirm. When idle, the same
key quits.

### The tracking files

In `design` and `work` mode the agent keeps `task.md` and `implementation_plan.md` up to
date. The plan is reset when an item starts and ticked as each verified step lands.

### The status line

The bottom rows show the current mode and model, the context meter and the working time.
The context meter is repainted right before each provider call, so it reflects what the
next request will actually carry. A compaction is announced in the transcript before it
runs.

### Copying a selection

Drag over text in the conversation and release. That writes the text to a file in the
workspace and puts it on your clipboard:

```
.moncho.clipboard.HHMMSS      # local time of the copy, e.g. .moncho.clipboard.091507
```

A four-second toast in the top-right corner names the file. It says **saved**, not
**copied**, because the agent cannot see your clipboard — the name is what you need either
way.

**How it reaches your clipboard.** The container cannot: a Unix clipboard tool is a client of a display
server it does not have, and an OSC 52 sequence only works if your terminal honours it. So
the agent writes the file and **the runner reads it on your host**, where the clipboard
lives — the workspace is bind-mounted, so it is the same file on both sides. No display
socket is forwarded and no privilege is granted. The runner feeds each file to the first
tool it finds:

| Host | Tool |
| ---- | ---- |
| macOS | `pbcopy` |
| WSL | `clip.exe` |
| Wayland (`WAYLAND_DISPLAY` set) | `wl-copy` |
| X11 (`DISPLAY` set) | `xclip -selection clipboard`, else `xsel --clipboard --input` |

The watcher lives exactly as long as the container: a foreground `run` ends it on exit, a
detached `start` leaves it until `moncho-cli stop`.

**When only the file is written** — it is still there to open in each case:

- **no display server** — SSH without X forwarding. No tool is found, so no watcher starts.
- **no bind mount** — `--do-not-mount` or `--copy-files`; the agent writes into the
  container's `/app`, which the host cannot see.
- **`--sync-files`** — the file arrives in your directory only when the run ends, by which
  time the watcher has stopped.

**Two guarantees.** A copy never overwrites an earlier one — a second selection in the same
second gets `.moncho.clipboard.091507-2` — and starting the agent never clobbers your
clipboard, because files already in the workspace when the watcher starts are left alone.
The files are gitignored (a project's `.git/info/exclude`), so they never appear in a diff.

## Sessions

Every turn is snapshotted. Sessions live in the state volume, under `agent/sessions/`,
one folder per session holding `context.json` beside its tracking files. `/sessions`
lists them; picking one resumes it with its context and its usage table intact.

## The suite, in the container

The dev image ships Node 22 and the dev dependencies, so the suite runs in there. That
is the maintainer's loop, and it is the one to prefer: the host needs Docker and not Node.js.
That is the loop to prefer, because it is the same image the agent runs in.

```bash
./start.sh start
./start.sh exec npm test
```

A host run — `npm test` with Node installed on your machine — is the opt-out, not the
flow. It works, but it needs Node on the host, which the container loop does not. The
container's `/app/node_modules` is a volume seeded from the image, so the suite resolves
the same dependencies the agent does.

The host run is the opt-out, not the flow: nothing in the maintainer's loop needs Node
on the host.

## Uninstalling

```bash
curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/scripts/install.sh \
  | bash -s -- --uninstall
```

The installer is not part of the payload it installs, so it is fetched again to run the
uninstaller; from a checkout, `./scripts/install.sh --uninstall` does the same.

That removes the installation and the symlink. It prints — but does not run — the
`docker rmi` command for the images it created, so you can see what is being removed
before anything is deleted. Named state volumes survive; remove one with
`docker volume rm moncho-state-<hash>` when you no longer want the sessions.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `the docker daemon is not reachable` | Start Docker Desktop, or `colima start` |
| `moncho-cli: command not found` | `~/.local/bin` is not on `PATH`; the installer printed the line |
| The agent cannot reach the provider | The base URL must be reachable from *inside* the container; a host Ollama needs the gateway name |
| Files are owned by root | The container was started without the uid mapping; remove it and let the runner recreate it |
| `not a git repository` | Run `git init`, or move into an existing repository, or pass `--skip-git` |

## Where the rest is written down

- [REQUIREMENTS.md](REQUIREMENTS.md) — what the host, the container and the provider must provide.
- [CONTRIBUTING.md](CONTRIBUTING.md) — forks, pull requests, and the maintainer loop.
- [PRIVACY.md](PRIVACY.md) — what leaves the machine and what is stored.
- [LIABILITY.md](LIABILITY.md) — the warranty position.
- [docs/README.md](docs/README.md) — the behavioural contract, one spec per capability.
- [templates/README.md](templates/README.md) — the Monchofile contract.
