# Contributing

Pull requests are closed. Forking is the channel, and it is a real one: the whole thing
is MIT, the installer reads the repository it fetches from, and a fork is a working
install rather than a read-only copy. This document is the fork path, the maintainer
loop, and the one convention that matters if you ever send a change upstream.

## Fork it and run it

`scripts/install.sh` reads two environment variables for the repository it downloads
from, so a fork needs no patch:

```bash
MONCHO_REPO=<you>/moncho-cli MONCHO_REF=main ./scripts/install.sh
```

`MONCHO_REPO` defaults to `moncho-cli/moncho-cli` and `MONCHO_REF` to `main`, which is
the same default the README's install URL uses. Point them at your fork and the
installer fetches your tag, stages your payload and links your command.

A fork you intend to keep needs a release of its own: the installer downloads
`archive/refs/tags/<ref>.tar.gz`, so a tag in your repository is what makes
`MONCHO_REF=v0.1.0` mean something. A branch ref works too, and installs whatever is on
the branch at that moment.

## The maintainer loop

The development loop runs this checkout in a container, from the image `./Dockerfile`
builds. The host needs Docker, not
Node.js: the image supplies Node 22 and the dependencies, and the source is mounted in
so an edit needs no rebuild. That is the recommended loop, because it is the same image
the agent runs in and it needs nothing on the host but a daemon.

```bash
./start.sh run        # foreground
./start.sh start      # detached
moncho npm test       # the suite, in the running container
./start.sh stop
```

`make dev` is the same thing as `./start.sh run`. `bin/moncho` is the helper that
executes a command in the container the loop started; it is a maintainer's tool and is
not installed by `scripts/install.sh`.

A host run is the alternative, and it needs Node 22 and `npm ci` in the checkout:

```bash
npm ci
node main.js
npm test
```

That host run is the opt-out, not the flow. The suite runs in the container too, and
that is where it should run: `/app/node_modules` is a volume seeded from the image, so
the suite resolves exactly the dependencies the agent does. Keeping the two the same is
what makes a green suite mean something.

## The three realms

This repository keeps code, docs and tests in three realms, and a change is finished
only when all three agree:

| Realm | Where | What it is |
| ----- | ----- | ---------- |
| Code | `app/`, `api/`, `config/`, `tools/`, `utils/`, `main.js` | What the agent does |
| Docs | `docs/<domain>/<capability>/` | The contract: `behaviour.md` and `spec.yaml` |
| Tests | `tests/` | The proof, named after the capability |

Every source module needs a spec, every spec names its code and its test cases by
`path#symbol`, and `tests/docs-realm.test.js` fails when any of those links breaks. The
conventions are in [docs/README.md](docs/README.md) and [tests/README.md](tests/README.md).

**This convention is Moncho's own, for its own repository.** It is a good idea and it is
enforced here, but it is not a requirement for your fork: a fork may drop the linking
test, reorganise the docs, or keep a single test file. Nothing in the runtime depends on
it — the agent loads no spec at run time.

## Changing the agent

1. Read the spec for the capability you are changing before you touch the code. If there
   is none, that is the first thing to write.
2. Change the code. Keep a module under 300 lines; past that, split it by
   responsibility and keep the import path working.
3. Update the spec: the behaviour, and the `path#symbol` references if a symbol moved.
4. Add or update the case in `tests/`, named after the capability.
5. Run the suite in the container: `moncho npm test`. A failing case is a real failure,
   not a flake; the suite is deterministic and uses no network.

### What the suite covers

- The realm links: every spec registered, every symbol real, every named case present.
- The provider call, normalisation, retries and the abort path.
- The tool loop, the mode gate and the multicall envelope.
- The context window, compaction and the usage table.
- The terminal front end, on a pty.
- The tracking files and the session store.

The suite runs with `node --test`, needs no network and no Docker daemon, and a full run
takes a couple of seconds.

### Style

- ES modules, no build step, no transpiler.
- One responsibility per module, and a comment that says why rather than what.
- A behaviour belongs in the spec, not in a comment that will drift.
- A shell script must parse under `bash -n`; `make check-shell` runs that over every
  script that ships.

## What not to send upstream

- A change that only reformats a file.
- A new dependency without a reason in the spec.
- A behaviour change with no spec and no test.
- A secret. The `.env.moncho` file is ignored on purpose; keep it that way.

## Reporting a problem

Open an issue in the fork you are working from, or in the upstream repository. A useful
report names the command, the mode, the provider and the model, and pastes the relevant
lines from `agent/logs/` — the operational log records what the agent did, not what the
model said.

## Licence

MIT. A contribution is offered under the same licence; see [LICENSE](LICENSE) and
[LIABILITY.md](LIABILITY.md).
