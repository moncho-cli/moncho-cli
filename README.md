![Moncho](moncho.png)

# Moncho

A terminal coding agent that runs itself: it reads, patches, searches and runs
commands, then shows you what it did. It runs in a container, keeps its own state out
of your repository, and talks to any OpenAI-compatible provider or to Ollama.

- **Tools with an intent.** Every call carries a short phrase saying why, shown next to
  the result and kept in the context.
- **A sandbox, not a shell.** `run_bash` accepts one allow-listed command and no shell
  metacharacters; file tools refuse to leave the project root.
- **Verified writes.** `patch_file` applies a unified diff and reads the file back
  byte-for-byte before reporting success.
- **A context budget it manages.** Usage is estimated per call, compaction is announced
  before it runs, and the tail of the conversation stays verbatim.
- **Three intent modes.** `chat` reads only, `design` also writes the tracking files,
  `work` is unrestricted. `Tab` walks the ring.
- **Nothing leaves the machine but the model calls.** No telemetry, no analytics.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/scripts/install.sh | bash
```

The installer stages the payload under `~/.config/moncho-cli` and links `moncho-cli`
onto your `PATH`. It needs `curl`, `tar` and a working Docker daemon — and no Node.js
on the host, because the agent runs in a container. Pin a release with
`MONCHO_REF=v0.0.1`; install elsewhere with `MONCHO_HOME=/opt/moncho`.

Then, in any project directory:

```bash
moncho-cli
```

The first run prepares the directory: it adopts an existing `Dockerfile` when there is
one, otherwise it asks for the project kind and writes a `Monchofile` from a starter.
It bakes the agent base image once, builds the project image, and starts the agent with
your workspace mounted at `/app`. State — sessions, `task.md`, the plan, the log —
lives in a named volume, so nothing is written into your repository.

## The two rules of a Monchofile

1. The first `FROM` is `moncho-agent`; the agent's runtime sits under your app's.
2. No `ENTRYPOINT`: the runner appends the agent's own, so your server does not start
   instead of the agent.

Everything else is an ordinary Dockerfile. See [templates/README.md](templates/README.md)
for the contract and [demos/README.md](demos/README.md) for a run-through.

## Documentation

| Document | What it covers |
| -------- | -------------- |
| [USAGE.md](USAGE.md) | Install and run on Linux and macOS, configuration, commands, sessions, modes |
| [REQUIREMENTS.md](REQUIREMENTS.md) | What the host, the container and the provider must provide |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Forks, pull requests, the maintainer loop, the realm rule |
| [PRIVACY.md](PRIVACY.md) | What is sent, what is stored, and where |
| [LIABILITY.md](LIABILITY.md) | The warranty and responsibility position |
| [docs/README.md](docs/README.md) | The behavioural contract: one spec per capability |
| [tests/README.md](tests/README.md) | The proof: one suite per capability |

## What it costs

The numbers below are the provider's own accounting for a real session, read from the
OpenRouter dashboard. The cache-hit rate is the reason a long session stays affordable:
the request prefix never changes between calls, so the prompt cache is hit on every
turn after the first.

### Half an hour — 201 requests, 28.7M tokens, 98.8% cached

![The OpenRouter dashboard after half an hour: 201 requests, 28.7M tokens, a 98.8% cache hit rate](docs/metrics/screenshots/cache-hit-rate-half-hour.png)

### One hour — 526 requests, 79.1M tokens, 98.1% cached

![The OpenRouter dashboard after one hour: 526 requests, 79.1M tokens, a 98.1% cache hit rate](docs/metrics/screenshots/cache-hit-rate-one-hour.png)

### Three hours — over 1k requests, 170M tokens, 96% cached

![The OpenRouter dashboard after three hours: over 1k requests, 170M tokens, a 96% cache hit rate](docs/metrics/screenshots/cache-hit-rate-three-hours.jpeg)

### What a compacted session looks like

The same accounting appears in the transcript, with the summary chunk in place of the
block it replaced — the conversation above it is gone, its essence is not.

![A transcript where the older 80% of the conversation has been replaced by one summary chunk](docs/metrics/memento-you-have-been-previously-compacted.jpeg)

## The three realms

| Realm | Where | Role |
| ----- | ----- | ---- |
| Code | `app/`, `api/`, `config/`, `tools/`, `utils/`, `main.js` | The truth: what the agent does |
| Docs | `docs/<domain>/<capability>/` | The contract: `behaviour.md` plus `spec.yaml` |
| Tests | `tests/` | The proof: one suite per capability |

A behaviour is finished when a spec describes it and a test proves it. `npm test`
enforces the links: a spec directory without its pair, a `path#symbol` that names
nothing, or a source module no spec covers all fail the suite.

## Layout

```
main.js              the host loop: front end, sessions, commands, tracking
app/                 conversation manager, tool batches, context window, TUI
api/                 the provider call: retries, normalisation, the system prompt
config/              constants and config/prompt.md
utils/               sandbox, patch, sessions, logger, compaction, usage
bin/                 the container runner (moncho-cli) and its libraries
scripts/             the installer
docs/  tests/        the contract and the proof
```

`agent/` is gitignored and holds the session state, tracking files and the log. It is
disposable: delete it and the next run starts clean.

## Developing the agent

The maintainer loop runs this checkout in its own container, through `./start.sh`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full instructions; the short version is
`./start.sh run` (or `make dev`) to run it, and `./start.sh exec npm test` for the
suite — inside that container.

## Licence

MIT. See [LICENSE](LICENSE). The warranty position is in [LIABILITY.md](LIABILITY.md).