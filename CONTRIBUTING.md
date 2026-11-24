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
`MONCHO_REF=v0.1.1` mean something. A branch ref works too, and installs whatever is on
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
./start.sh exec npm test   # the suite, in the running container
./start.sh stop
```

`make dev` is the same thing as `./start.sh run`, and `./start.sh exec <command>` runs
one command inside the container the loop started. `moncho-cli` is the *user's* entry
point: it prepares a project directory and drives its own container. The two flows stay
separate, so neither command is a shorthand for the other.

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

### Configuration: `.env`, and not `.env.moncho`

`./start.sh` reads **`./.env`** in this checkout. Start from the example:

```bash
cp .env.example .env    # then fill in the provider
```

That is the one thing this flow and the user flow deliberately do differently, and it is
worth being precise about, because the axis is *which script runs where* — not who the
person is:

| Flow | Entry point | Env file |
| ---- | ----------- | -------- |
| **Maintainer** (this page) | `./start.sh` in this checkout | `./.env` |
| **User** (USAGE.md) | `moncho-cli` in their project's directory | that project's `./.env.moncho` |

The two names exist so that a checkout's `.env` and a user's project `.env` never mean the
same thing. `moncho-cli` deliberately ignores a generic `.env`, so a project's own credentials
cannot become the agent's provider; and this loop never reads `.env.moncho`, because the file
it is looking at is its own checkout's config rather than some project's.

`start.sh` forwards **every name** the file defines, as `-e NAME`, so there is no list to
keep in step: a new setting only has to be declared in `.env` and read by the app. (This is
why `-e NAME` rather than `-e NAME=value` — docker reads the value from the process, so a key
never appears in the host process list.) Both example files declare the same names, and
`tests/env-files.test.js` fails when one gains a setting the other lacks.

### The host fence is off in this loop

`./start.sh` runs *this* checkout, so it passes `MONCHO_MAINTAINER=1` into the container and
the host fence is lifted (`docs/agent/host-fence`). A **user's** project gets the fence, which
refuses git hooks and `.env.moncho` because the host executes both: a prompt-injected agent
writing one would be running its own code on the host. A maintainer reads every diff and owns
the repository, so a hook here is their tool, not an injection — the fence would only be in
the way. The read-only shadow mounts are the user flow's boundary and are unaffected; this
loop uses its own `docker run`.

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

## Bump the version before you finish

`package.json#version` is the single source of the release tag: `scripts/release.mjs`
derives `v<version>` from it, and the installer fetches `archive/refs/tags/<ref>.tar.gz`.
A session that changes behaviour and leaves the number alone makes the next release carry
more than its tag says, so **every session that changes behaviour moves the version**.

The move matches the change — a breaking change is a major, a new behaviour a minor, a
fix, a document or a test a patch — and **one step is enough even when the session
changed many things**. The bump marks the session, it does not measure it: three features
and a fix in one session are still one release. What the rule refuses is a number that
never moved, or one that moved backwards; a single step that understates the change is
reported as a note, never as a failure.

```bash
node scripts/bump-version.mjs --minor     # 0.2.0 -> 0.3.0, manifest + lockfile
node scripts/bump-version.mjs --check     # did this session move it past the last tag?
```

`package-lock.json` records the same version twice and npm reads both, so the manifest
and the lockfile move together — the script rewrites both and verifies each write. The
rule is stated in `docs/maintainer/version-bump/`, and `scripts/release.mjs` refuses a
manifest that never moved past the last tag.

This is a **maintainer habit, not a runtime rule**: the session bumps when you ask it to,
and it is you who decides the step. It is deliberately absent from `config/prompt.md`,
which is not a document of this repository but the system prompt of every install — the
session reading it usually stands in a *user's* project, where this repository's version
means nothing and the file it names may not even exist.

## Changing the agent

1. Read the spec for the capability you are changing before you touch the code. If there
   is none, that is the first thing to write.
2. Change the code. Keep a module under the **configured file size budget**
   (`FILE_LINE_LIMIT`, default 600 lines); past that, split it by responsibility and
   keep the import path working. The number the agent is told is the same one, rendered
   into `config/prompt.md` — change the variable, not the prose.
3. Update the spec: the behaviour, and the `path#symbol` references if a symbol moved.
4. Add or update the case in `tests/`, named after the capability.
5. Run the suite in the container: `./start.sh exec npm test`. A failing case is a real
   failure, not a flake; the suite is deterministic and uses no network.

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
