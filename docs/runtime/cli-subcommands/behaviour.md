# Runtime — CLI subcommands (`moncho-cli <word> …`)

`moncho-cli` runs the agent. It is also the natural front door for **companion tools** that
live beside the agent — a bench, a dashboard, a site-specific script — and those must be
reachable without this program carrying a list of them.

The mechanism is the convention `git` and `cargo` already use: a first word that
`moncho-cli` does not implement as a command is taken to name a companion, and
`moncho-cli <word> …` runs `moncho-<word>`.

```
moncho-cli bench build      # runs moncho-bench build
moncho-cli bench run --instances a,b
```

## The rule is stated in terms of shape, not of tools

A first word is a **companion request** when it is neither a flag nor one of the commands
this program implements. Everything else is this program's own business.

- **A flag is never a companion.** `moncho-cli --version`, `moncho-cli -h`: a word
  beginning `-` belongs to this program. This is what keeps the seam from swallowing the
  options a user reaches for first, and it is why the check is on the *first* word only.
- **A built-in wins.** `run`, `start`, `stop`, `shell`, `build`, `status`, `uninstall` and
  `help` are this program's commands, whatever a companion might be called. A companion
  can therefore never shadow one, and `moncho-cli build` keeps meaning what it always
  meant even on a machine with `moncho-build` installed.
- **No first word at all is not a request.** Bare `moncho-cli` is `run`, as it has always
  been: an empty invocation must not turn into a hunt for `moncho-`.

## What this program knows about a companion

**Nothing.** The seam resolves a name and hands over the rest of the command line; it has
no table of companions and no per-tool behaviour. Three reasons, in order of how much
they cost to get wrong:

- **The payload ships everywhere, including into the container.** `bin/` is in the
  installer's allow-list, and the agent image's entrypoint is `node main.js`. A table of
  companion names here would be a list of capabilities the agent carries but does not own,
  and it would put a name in the payload that has nothing to do with running the agent
  (see `docs/agent/host-fence`).
- **A name in a table is a name to keep in step.** A companion that is renamed, or a
  second one that appears, would each be a change to this program for no reason. The seam
  is a rule about shape, and it does not move when the tools beside it do.
- **It keeps the ordering free.** There is no list to search and no priority to decide:
  flags, then built-ins, then a companion by name, and a companion that does not exist is
  an error rather than a fallthrough.

## Resolution, and the refusal

The companion is looked up on `PATH` by the name `moncho-<word>`. Resolution requires an
**executable**: a path that exists but cannot be executed is treated as absent, because
`exec` on one fails with a permissions message that sends a reader looking at the wrong
thing. The lookup, the hand-over and the refusal are all in `bin/lib/subcommand.sh`.

- **The command line is handed over verbatim.** The companion receives every argument
  after its own name, untouched and in order, and this program never inspects them. This
  is a hand-over, not a parse: `moncho-cli bench run --instances a,b` gives the companion
  exactly `run --instances a,b`, and a companion's own flags can never collide with this
  program's.
- **The exit status is the companion's.** The seam does not interpret it, so a tool that
  reports failure fails the whole invocation, which is what a caller scripting
  `moncho-cli bench run` depends on.
- **A missing companion is a refusal, not a fallthrough.** The word was recognised as a
  companion request, so answering "unknown command" would be wrong — it would suggest this
  program might have owned it. The refusal says the tool is not installed, names the
  `moncho-<word>` it looked for, and says where companions come from.
- **The seam is reached before the workspace is resolved.** A companion is a program in
  its own right, with its own idea of what a workspace is: a bench is a directory of its
  own, and `moncho-cli bench init` must work in one whose git repository this program
  would refuse. Nothing about the agent's workspace, env file or repository gate is
  applied to a companion.

## See also

- Implementation: `bin/lib/subcommand.sh`, `bin/moncho-cli`
- Why the payload must stay free of companion names: `docs/agent/host-fence`
- The install that puts a companion on `PATH`: `bench/install.sh`
