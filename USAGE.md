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
| `--uninstall` | Remove the installation and the `~/.local/bin` entry |
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
| `moncho-cli uninstall` | Remove the installation (`--purge --yes` takes the images and volumes) |
| `moncho-cli help` | The command's own help |

## Options

| Option | Effect |
| ------ | ------ |
| `--env <path>` | Read this env file instead of `./.env.moncho` |
| `--version <v>` | Run this installed version (default: the newest installed) |
| `--continue` | Open the newest session of this version instead of starting a fresh one |
| `--state-in-repo` | Keep the state in `./agent` instead of a named volume |
| `--do-not-mount` | No bind mount: `/app` is what the image contains |
| `--copy-files` | Copy the workspace into the image at build time |
| `--sync-files` | Copy `/app` back into this directory when the run ends (`agent/` is always excluded) |
| `--sync-delete` | Let `--sync-files` delete host files (needs `rsync`) |
| `--rebuild` | Rebuild the project image |
| `--build-base` | Repaint the agent base image even when it exists |
| `--base-only` | With `build`: stop after the base image |
| `--skip-git` | Work here without a git repository |
| `--yes`, `-y` | Take the default template instead of asking; with `uninstall --purge`, confirm it |
| `--purge` | With `uninstall`: also remove the images and the state volumes (needs `--yes`) |

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
| `MODEL_TEMPERATURE` | unset | Sampling temperature (`0`–`2`); unset leaves the key out of the request |
| `MONCHO_USER_AGENT` | unset | `User-Agent` header sent with every provider call and every `web_fetch`; unset sends none to the provider and presents `moncho-cli` when fetching |
| `CONTEXT_MAX_LENGTH` | the provider's real total | Context budget override |
| `COMPACTION_OLD_RATIO` | `0.7` | Share of the window summarised on compaction (`0.7`, `70` or `70%`) |
| `CHUNKPACTION_ENABLED` | off | Collapse a solved item's section into a summary and keep its raw chunks as a capture; set `1`, `true`, `on`, `yes` or `y` to turn it on (worth it under local inference, where the window is the cost; a cloud provider caches the verbatim prefix instead) |
| `PULSE_LIMIT` | `30` | Model calls before the pulse notice |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `off` |
| `LOG_MAX_BYTES` | `524288` | Rotation threshold |
| `LOG_MAX_FILES` | `3` | Rotation chain length |
| `CLIPBOARD_FILE_KEEP` | `single` | What a saved selection leaves behind: `single` keeps only the last copy, `all` keeps a timestamped history |
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
| `/skins` | Change this project's colours and presentation |
| `/usage` | Print the token breakdown for the session |
| `exit` | Quit |

**ESC** or **Ctrl+C** cancels a running task; press twice to confirm. When idle, the same
key quits.

### Skins

A **skin** is a saved look for the project: the conversation palette and a few
presentation details (the border, the brand mark, the input hint). Skins are per project
and live as JSON under `agent/skins/`, so each project keeps the colours you gave it and
reopens in them.

| Command | What it does |
| ------- | ------------ |
| `/skins` | List this project's skins and mark the active one |
| `/skins <name>` | Apply a saved skin, and remember it for the project |
| `/skins save <name>` | Save the look on screen now under a name |
| `/skins <name> intent=bright-yellow user=cyan save warm` | Build a look from individual colours, and save it |
| `/skins reset` | Go back to the shipped default |
| `/skins prompt a warm sunset` | Describe a new skin in words (below) |
| `/skins customize make the intent warmer` | Adjust the active skin in words (below) |

Every colour is a terminal colour **name** — `cyan`, `bright-blue`, `bright-green` — not a
hex code, because the screen paints named colours. The palette keys are `user`, `tool`,
`intent`, `context`, `error`, `notice`, `tracking` and `refusal`.

#### Asking for a skin in words

`/skins prompt <description>` opens a **modal sub-chat**: the agent makes one model call
to turn your description into a proposed skin, then shows the palette inside the box with
three choices — **Apply for this session**, **Apply and save to `agent/skins/`**, or
**Cancel** (Escape closes it too). Nothing changes until you pick one.

While the model is still working there is nothing to apply, so the box offers **only**
Cancel and Enter cancels; the two apply choices appear with the proposal. The proposal's
name sits in an **editable field** prefilled with what the model chose — type to change it,
and the name the skin is saved under is the slug of what you typed (`Warm Sunset` →
`warm-sunset`). Enter in the field moves to the choices, Tab moves back, Escape cancels. An
empty name, or one that folds to the built-in `default`, takes the apply choices away and
says why, so a bad name is fixed before anything is written.

The proposal is a starting point, not a verdict: it is filled in from the skin already in
force, so a colour the model did not name is left alone, and a colour it invented that
the terminal does not know is ignored.

#### Adjusting the skin you are using

`/skins customize <description>` opens the same modal, but asks the model to **change the
skin already in force** instead of inventing a new one. The box has no name field — the
name is settled — and offers **Update the active skin** or **Cancel**. The change is
written over the active skin's own file, so the project keeps opening in it and nothing
new is created. With no active skin there is nothing to adjust, so the command refuses
and suggests `/skins prompt` instead.

#### Editing a skin by hand

A skin is an ordinary JSON file, so you can open `agent/skins/<name>.json` and edit it;
the next run that applies it uses what is in the file. Delete the file and the name is
gone. With the default state volume the directory lives in that volume; under
`--state-in-repo` it is `./agent/skins/`, and `agent/` is excluded from git either way.

Colour is presentation only: it never reaches the model and it is never written into a
session, so a skin cannot change what the agent knows or does.

If a skin seems to change nothing, turn the log up and read what `/skins` did:
`LOG_LEVEL=info` (see [Configuration](#configuration)). Every command writes an info line
under the `skins` scope — which action ran, which skin was applied, and `no skin proposed;
the look is unchanged` when the modal was cancelled or the model answered nothing usable.
The same message is printed on screen, so a no-op is never silent.

Applying a skin repaints the conversation that is already on screen as well as the chrome:
the transcript stores the *uncoloured* rendered rows and the palette is applied when the
region paints, which is what lets one command recolour a session already in progress.

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

The runner removes itself, since it is the one thing guaranteed to be installed:

```bash
moncho-cli uninstall
```

That deletes the `~/.local/bin/moncho-cli` entry (a symlink, or a regular file if you
wrote a wrapper there) and the staged tree in `MONCHO_HOME`, wherever `--dir`,
`MONCHO_HOME` or `XDG_BIN_HOME` put them — the verb reads the same variables the
installer did, so no path has to be repeated. It needs no Docker daemon. Your project
directories are never touched: a `Monchofile`, a `.env.moncho` and a `.moncho/` stay
where they are.

The images and the named state volumes are left alone, because the volumes *are* your
session history, one per workspace. Take them too with:

```bash
moncho-cli uninstall --purge --yes
```

`--purge` removes every `moncho-agent:*` and `moncho-project:*` image and every
`moncho-state-*` volume, and stops any container Moncho left running. It needs `--yes`
because the volumes are not recoverable.

If the installation is already broken, half-removed, or `moncho-cli` is no longer on
`PATH`, the installer carries the same job — it is not part of the payload it installs,
so it is fetched again to run:

```bash
curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/scripts/install.sh \
  | bash -s -- --uninstall
```

From a checkout, `./scripts/install.sh --uninstall` does the same. This path names the
`docker rmi` and `docker volume ls` commands instead of running them.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `the docker daemon is not reachable` | Start Docker Desktop, or `colima start` |
| `moncho-cli: command not found` | `~/.local/bin` is not on `PATH`; the installer printed the line |
| The agent cannot reach the provider | The base URL must be reachable from *inside* the container; a host Ollama needs the gateway name |
| Files are owned by root | The container was started without the uid mapping; remove it and let the runner recreate it |
| `EACCES: permission denied, mkdir '/app/agent/sessions/…'` | The state volume arrived root-owned. `moncho-cli` fixes it on the next `run`; if it persists, `docker volume rm moncho-state-<hash>` and run again |
| `not a git repository` | Run `git init`, or move into an existing repository, or pass `--skip-git` |

## Where the rest is written down

- [REQUIREMENTS.md](REQUIREMENTS.md) — what the host, the container and the provider must provide.
- [CONTRIBUTING.md](CONTRIBUTING.md) — forks, pull requests, and the maintainer loop.
- [PRIVACY.md](PRIVACY.md) — what leaves the machine and what is stored.
- [LIABILITY.md](LIABILITY.md) — the warranty position.
- [docs/README.md](docs/README.md) — the behavioural contract, one spec per capability.
- [templates/README.md](templates/README.md) — the Monchofile contract.
