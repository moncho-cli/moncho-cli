# A run-through, end to end

This is the **user** flow: nobody clones the repository, `scripts/install.sh` puts
`moncho-cli` on the PATH, and the first run in a directory prepares it. Developing the
agent itself is a separate flow — clone the repo and use `./start.sh run` (or
`make dev`); `moncho-cli` recognises that checkout and refuses to prepare it.

Two commands, from an installed `moncho-cli` to an agent working in a container scoped
to this directory. The first run in a project does the preparation itself.

```bash
cp .env.moncho.example .env.moncho   # fill in the provider key once
moncho-cli                           # prepare, build, run
```

The example uses a checkout instead of a staged install, which is the fastest way to
try the packaging work:

```bash
MONCHO_HOME=. ./bin/moncho-cli
```

`MONCHO_HOME=.` is only needed because nothing has been installed yet: the runner
otherwise reads `~/.config/moncho-cli`. Export it once and the prefix disappears:

```bash
export MONCHO_HOME=$PWD
./bin/moncho-cli status
```

## What the first run does

1. **Resolves the project type.** With a `Dockerfile` already present, it is adopted:
   the first `FROM` becomes `moncho-agent`, so the agent's runtime sits under the app's
   own, and the app's `ENTRYPOINT`/`CMD` are dropped (they belong to the app's server,
   not to the agent). Without one, the project kind is detected from `package.json`,
   `pyproject.toml` or `go.mod`, and a starter is offered — or picked from the menu.
2. **Bakes what is missing.** The base image `moncho-agent:<version>` is baked from the
   installed payload the first time and reused while the version is unchanged. The
   project image is built from the `Monchofile`, and rebuilt when the Monchofile or the
   base image changes.
3. **Starts the agent** in the foreground. `run` is what a bare invocation means.

## What each command does

```
status   workspace /workspace/some/project
         container moncho-<hash>          <- derived from the directory
         image     moncho-project:<hash>  <- one per directory
         base      moncho-agent:<version>
         state     volume moncho-state-<hash> (mounted at /app/agent)
         mount     bind
```

- **`run`** (or a bare `moncho-cli`) starts the agent in the foreground and removes the
  container when it exits. The state — sessions, `task.md`, the log — lives in a named
  volume, so the next run finds it again and the checkout stays clean.
- **`start`** does the same detached, and **`shell`** drops you inside it.
- **`build`** rebuilds the project image unconditionally; `--build-base` repaints the
  base image as well.
- **`stop`** stops and removes this directory's container.
- **`status`** prints the resolution above without touching Docker.

## The two rules of a Monchofile

1. first instruction `FROM moncho-agent` — the agent is already in that base image;
2. no `ENTRYPOINT` and no `CMD` — the runner appends the agent's own entrypoint after
   your instructions.

A Monchofile that breaks either rule is refused before anything is built. An adopted
Dockerfile is converted rather than refused, except for two shapes that cannot be
salvaged: a multi-stage file (the last stage is what ships, and the agent may not be in
it) and a base the agent's Alpine runtime cannot replace (only `node:*alpine`-style
bases are accepted).

## Two projects, two containers

```bash
cd ~/project-a && moncho-cli run
cd ~/project-b && moncho-cli run
```

Nothing is shared but the base image: each directory gets its own container, image and
state volume.

## What cannot be checked here

The container lifecycle needs a Docker daemon. This workspace has none, so the shell
half is verified by parsing (`make check-shell`) and by the runner's docker-free logic
(`make probe`), not by a real `docker build`. Run the four commands above on a machine
with Docker to complete the acceptance list in `agent/tmp/distributing.md` §10.
