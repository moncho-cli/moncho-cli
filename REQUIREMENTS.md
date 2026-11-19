# Requirements

What Moncho needs in order to run, split by whose problem each requirement is. The
short version: **the host needs Docker and not Node.js.** Everything else is either
inside the image or provided by the model provider you choose.

[USAGE.md](USAGE.md) shows how to use the result, [CONTRIBUTING.md](CONTRIBUTING.md)
covers the maintainer's loop, and [README.md](README.md) is the front page.

## The host

### Required, for the user flow

| Requirement | Why | Checked by |
| ----------- | --- | ---------- |
| `bash` | The installer and the runner are bash scripts | `scripts/install.sh` runs under it |
| `curl` | The installer downloads the release tarball | `installer` header |
| `tar` | The tarball is extracted with it | `installer` header |
| A Docker daemon | The agent runs in a container | `docker info` |
| A git repository | The workspace's exclusion rules live in `.git/info/exclude` | The runner's precondition |
| `rsync` | Only for `--sync-delete` | Optional |

The host does **not** need Node.js on the host. Node 22 and the dependencies live inside
the image, and the agent's commands run there. A host without Node installed runs the
agent exactly as a host with it does.

### Required, for the maintainer flow

The maintainer's loop runs the same image, so it needs the same Docker daemon and
nothing more. The suite runs there too, through the runner's own `exec`:

```bash
./start.sh start
./start.sh exec npm test
```

A host run needs Node 22 and `npm ci` in the checkout, and is the opt-out rather than
the flow. Nothing in the flow itself requires it.

### Platforms

| Platform | Status | Notes |
| -------- | ------ | ----- |
| Linux | Primary | The image is `node:22-alpine`; the runner is portable bash |
| macOS | Supported | Docker Desktop or Colima; the uid mapping means no `sudo` |
| Windows | Not supported | The scripts assume a POSIX host; WSL2 is untested |

The shell scripts are written for `bash` 3.2, the version macOS ships, so no array or
`mapfile` feature that requires bash 4 is used. The installer, the runner and the
helper all parse under it.

## The container

The image is `node:22-alpine` plus:

| Package | Why |
| ------- | --- |
| `bash` | The tools run shell commands; Alpine's default shell is not enough |
| `diffutils` | The patch cross-check needs `diff` |
| `patch` | Applying a unified diff |
| `git` | The agent reads the repository it works in |

`Dockerfile` (the dev image) and `Dockerfile.agent` (the base image baked from the
payload) carry the same package set. The dev image additionally installs the dev
dependencies, because the suite runs in it.

### Resources

| Resource | Minimum | Comfortable |
| -------- | ------- | ----------- |
| Disk | ~1 GB for the base image | ~2 GB with build cache |
| Memory | 1 GB for the container | 2 GB+ for a larger model |
| Network | Reach the provider's base URL | — |

The memory figure is the container's, not the model's: a model served from the host or
from a provider runs outside it.

## The provider

Moncho speaks the OpenAI chat-completions shape. Anything that implements it works:

| Provider | Base URL | Key |
| -------- | -------- | --- |
| OpenRouter | `https://openrouter.ai/api/v1` | Required |
| OpenAI | `https://api.openai.com/v1` | Required |
| Ollama, on the host | `http://host.docker.internal:11434/api/chat` | None |
| Ollama, elsewhere | `http://<host>:11434/api/chat` | None |

The base URL must be reachable **from inside the container**. `localhost` inside the
container is the container, not your machine; a host Ollama needs the gateway name the
runner adds with `--add-host`.

### What the provider must support

- Chat completions with a `messages` array.
- Tool calling (`tools` and `tool_calls`), for the agent's tools to work at all.
- A streaming response is used where the provider offers it; the client falls back to a
  single response otherwise.

A model that cannot call tools will answer in prose and never run a tool. That is a
provider limitation, not a configuration error.

## The workspace

| Requirement | Detail |
| ----------- | ------ |
| A git repository | The runner refuses a plain directory; `--skip-git` overrides |
| A `Monchofile` or a `Dockerfile` | One is adopted or generated on the first run |
| Writable by your uid | The container runs as you, so no `sudo` is needed |

The workspace is mounted at `/app`. The agent's state lives in a named volume, so the
repository stays clean. `--state-in-repo` moves the state into `./agent` instead, and
the exclusion goes into `.git/info/exclude`.

## The agent's own repository

The maintainer's checkout is not a workspace. The runner recognises it and refuses to
prepare it as a project, because its `Dockerfile` belongs to the development loop. The
override is `MONCHO_AS_PROJECT=1`, and the flow it replaces is `./start.sh`.

## Summary

| Whose requirement | Needs |
| ----------------- | ----- |
| A user | Docker, `bash`, `curl`, `tar`, a git repository |
| A maintainer | The same, plus the checkout; the suite runs there too |
| A provider | An OpenAI-compatible endpoint that supports tool calling |
| A host | Docker and not Node.js, on Linux or macOS |
