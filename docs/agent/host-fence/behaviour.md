# Agent — the host fence (paths the host executes)

The path sandbox (`docs/agent/file-safety`) keeps every file tool inside the project tree.
That is the right rule for the project's own files. It is the wrong rule for a handful of
paths **inside** the tree whose *content* the host runs as the user's own shell: a tool
asked "is this inside the project?" answers *yes*, and the answer is the danger.

This spec covers that second question. Implementation: `utils/host-fence.js`, linked at the
bottom.

## The threat

The workspace is bind-mounted into the container (`bin/lib/container.sh#build_run_args`), so
`/app` inside the container **is** the host's checkout. A write made there lands on the
host's filesystem. Two paths in a checkout are executed by the host rather than read:

- **git hooks** — `.git/hooks/pre-commit` and its siblings run on the host at the next
  `git commit`, as the user. `.git/config` is the same reach by another name: `core.hooksPath`
  points git at a hook directory of its choosing.
- **the env file** — `.env.moncho` is *sourced as shell* by the runner
  (`bin/lib/env.sh#resolve_env_file`), so its contents run as the user's shell when the CLI
  starts.

The threat model this answers is **injection through the model's context**: a prompt-injected
model that writes one of these paths has achieved code execution on the host, outside the
container. `.dockerignore` does not address it — that rule governs the build context, and
this is a runtime write.

## The rule

`hostExecutableKind(path)` classifies a path as one of three kinds, or `null`:

| kind | matched | why it is dangerous |
| --- | --- | --- |
| `git-hook` | `.git/hooks/<name>` | git runs it on the host at the next commit |
| `git-config` | `.git/config` | `core.hooksPath` redirects the hook directory |
| `env-file` | any `.env.moncho` | the runner sources it as the host's shell |

Matching is **segment-based**, so the answer does not depend on how the caller spelled the
path: `./.git/hooks/pre-commit`, `.git//hooks/pre-commit` and `.git\hooks\pre-commit` all
resolve to the same kind. It is case-sensitive, because git and the shell are. A `..`
segment is left in place rather than resolved, so the comparison fails closed. `.git` is
recognised at any depth, because a submodule's hooks run on the host too.

## The refusal

`hostExecutableRefusal(path)` returns a structured refusal, or `null` for an ordinary path.
The code is `HOST_EXECUTABLE_PATH`, and the message names the **kind** and the **mechanism**,
because the model's next move depends on it: a hook is not a file to try a different spelling
of. The guidance names the way out — tell the user what the hook or variable should do and
let them create it.

The fence is a **refusal, never a normalisation**. Unlike the tracking pair
(`docs/agent/task-tracking`), which accepts a draft and re-renders it, there is no draft a
host-executable file could legitimately become.

## Where it is wired

The fence runs **before** the sandbox resolves the path, in all three writers:

- `write_file` — refuses creating a hook or the env file;
- `edit_file` — refuses a search/replace *and* a pasted diff into one;
- `delete_file` — refuses removing one.

`read_file`, `hint_file`, `blob` and `grep` are unaffected: reading a hook is not running it,
and an agent that cannot inspect the repository is not one that can explain it.

## The maintainer flow is exempt

Two flows, two audiences, and they want opposite things from this fence.

| flow | entry point | the fence |
| --- | --- | --- |
| **user** | `bin/moncho-cli` against a project they own | **on** — they do not read its diffs |
| **maintainer** | `./start.sh` against this repository | **off** — they read every diff and own the checkout |

A maintainer is developing *this* program, so a hook in their own repository is their tool,
not an injection. `start.sh` passes `MONCHO_MAINTAINER=1` into its `docker run`, and
`config/constants.js#hostFenceEnabled` reads it: the switch is off and all three writers let a hook
or the env file through.

The switch is an **environment variable**, not a checkout check. The app runs *inside* the
container against a bind mount, so "is this the agent's checkout" would mean reimplementing
`bin/lib/template.sh#is_agent_checkout` in JavaScript against a path the container cannot see
as the host does — and it would also fire for a user who happens to name their own project
`moncho-cli`. An explicit variable is honest about being an override and cannot be guessed
wrong.

`hostExecutableKind()` still classifies the paths when the fence is off: only the *refusal*
is lifted. The kinds stay true, which is what lets a caller ask "is this a host-executable
path?" independently of whether the fence is enforcing right now.

The switch is read **when the fence is asked** (`hostFenceEnabled()`), not once at import,
and that is a property worth stating rather than an implementation detail: the suite runs
*inside* the maintainer's container, where the variable is ambient, so a switch frozen at
module load would leave the fence off before any case ran — the refusal tests could not pass,
and a check that silently stops checking depending on where it runs is worse than the bug it
guards. `tests/host-fence.test.js` therefore proves the **user's** flow by deleting the
variable, and one case proves the switch reads live by setting it and clearing it without a
reload. A production process never changes its environment mid-run, so reading late costs
nothing and changes nothing there.

## The container layer

The fence is a **tool-level** control, and `run_bash` reaches the same paths through the
allow-listed `git` and `node` without going through a file tool at all. So the fence is the
*explanation*, and the mount is the *boundary*.

In bind mode the workspace is mounted read-write at `/app`, and the runner shadows the two
host-executable paths with read-only mounts of their own
(`bin/lib/container.sh#build_run_args`):

```
-v "$WORKSPACE:/app"                              # the checkout, read-write
-v "$WORKSPACE/.git:/app/.git:ro"                 # a nested mount wins over its parent
-v "$WORKSPACE/.env.moncho:/app/.env.moncho:ro"
```

A nested mount wins over its parent, so git still reads and runs inside the container while
nothing — `run_bash` included — can write a hook or the env file. Each shadow is
**conditional on the path existing**, because docker creates a *directory* at a mount point
that does not exist, and a directory where `.env.moncho` belongs would be worse than no mount.

### The agent's own code is the third path

The same reasoning applies to the payload the agent *is*: `/opt/moncho-cli` holds the
runtime it executes, and a write there is self-modification — the one write that can
change what the next turn does. It is not covered by the fence above (the payload is
outside the project tree, so the sandbox never sees it) and it is not covered by file
modes either: the container runs as the host uid, which is **root when the host user is
root**, so "the files are root-owned" is not a boundary.

So the runner shadows it the same way, in bind mode:

```
-v "$MONCHO_HOME:/opt/moncho-cli:ro"          # the installed payload, read-only
-v /opt/node_modules                          # the dependencies, which npm writes
```

`node_modules` is the one part the agent may legitimately write — `run_npm install` is a
supported tool — so an anonymous volume lets the image's copy win over the host's, the
same trick `/app/node_modules` already uses. It lives at **`/opt/node_modules`, beside the
module root and never inside it**, and that placement is load-bearing: a volume mounted at
a path inside the read-only bind cannot be created, so the container dies at init
(`mkdirat /opt/moncho-cli/node_modules: read-only file system`) before the agent starts.
Node's resolver walks up from `/opt/moncho-cli` and finds `/opt/node_modules`, so the
dependencies still resolve. Both mounts are **conditional on the payload existing**
(`$MONCHO_HOME/main.js`), for the same reason the other two shadows are: a mount point that
does not exist becomes a directory.

This is the *boundary*; the tool-level half is that no file tool can name a path outside
the project tree at all (`docs/agent/file-safety`), so `/opt/moncho-cli` is unreachable
through `write_file` / `edit_file` / `delete_file` even before the mount is considered.

`GIT_OPTIONAL_LOCKS=0` is passed unconditionally: a read-only `.git` makes git's optional
index write fail noisily, and the flag keeps ordinary read commands quiet. It is harmless in
`copy`/`none` mode, where nothing is mounted at all.

## What it does not cover

The mount closes the write path in bind mode. It does not change what the **host** does with
the checkout afterwards: a hook already in the repository, or one the user planted, still runs
on the host. The fence protects against the *agent* writing one — not against a repository
that arrived with one.

## See also

- Implementation: `utils/host-fence.js`, `bin/lib/container.sh`
- The sandbox it complements: `docs/agent/file-safety`
- The tracking fence that is a normalisation rather than a refusal: `docs/agent/task-tracking`
- Proof: `tests/host-fence.test.js`, `tests/container-mount.test.js`
