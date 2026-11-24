# bench/ — the bench framework

A **bench** measures the agent on a public benchmark. It is not part of the agent: the
bench invokes `node main.js` and reads the workspace afterwards, and nothing under
`app/`, `api/`, `config/`, `tools/`, `utils/` or `main.js` knows it exists.

```
$ curl -fsSL https://raw.githubusercontent.com/moncho-cli/moncho-cli/main/bench/install.sh | bash
$ cd ~/benches && moncho-cli bench init --kind swe --name swe-lite
$ cd swe-lite && moncho-cli bench build && moncho-cli bench select && moncho-cli bench run && moncho-cli bench grade
```

One command makes a bench in a directory. Everything after that is that bench's own.

## What the host must provide

A bench drives **containers**, so it needs more of the machine than the agent does. The
list is worth stating plainly, because a missing item does not look like a missing item: it
looks like a broken bench, and the two are fixed in completely different places.

| Needed | By | Without it |
| ------ | -- | ---------- |
| `docker` **and a reachable daemon** | `build`, `select`, `run`, `grade`, `shell` | nothing runs: every stage is a container |
| `curl` or `wget` | `build` (payload, runtime), `select` (the dataset) | the payload and the subset cannot be fetched |
| `tar` | `build` (unpacking both archives) | the fetched tarballs cannot be opened |
| `git` | `run` (seeding a checkout, diffing the workspace) | no patch can be produced |
| network access to the dataset viewer and to the release archive | `build`, `select` | no instances, no agent |
| `python3` with the `swebench` package | `grade` | patches are produced and never scored |

Everything except `grade` is the framework's own business and is checked by the framework
before it starts work. `grade` is the one stage that depends on a *third-party* toolchain,
and it says so when the harness is missing rather than reporting zero resolved.

Nothing here is needed to **read** a bench — `status`, `explain` and `report` are host-side
and answer from `plan.json` and the run store. A machine with no docker can still describe a
bench and read the results another machine produced.

## Why this is a separate thing

The installer stages the **agent**, and it does so from an allow-list
(`scripts/install.sh#copy_payload`): `main.js`, `package.json`, `app/`, `api/`,
`config/`, `tools/`, `utils/`, `bin/`, `templates/`. A `bench/` directory is not on that
list, so it reaches nobody's install by accident. `bench/install.sh` fetches the *same*
release tarball and stages only `bench/`.

The two flows mirror the ones the project already has, and they stay separate:

| Flow | Entry point | Stages |
| ---- | ----------- | ------ |
| user | `moncho-cli` | the agent, per project directory |
| maintainer | `./start.sh` | nothing: runs this checkout |
| experimenter | `moncho-cli bench` | the bench framework, per bench directory |

## Three trees

The separation is the whole design: what may be replaced is not what holds the results.

| Tree | Default | Holds | Replaced by an upgrade |
| ---- | ------- | ----- | ---------------------- |
| **framework** | `~/.config/moncho-bench/versions/<ref>/` | `bench.sh`, `lib/`, `kinds/` | yes |
| **bench** | `~/benches/<name>/` | `Benchfile`, `.env.bench`, `plan.json`, `results/` | **never** |
| **payload** | `~/.config/moncho-bench/payload/<ref>/` | a pinned agent, `npm ci`'d | re-fetched, never edited |

A bench names its own `BENCH_NAME`, and everything derived from it follows: the image
tag, the results directory, the run labels. Two benches never share state, so two
providers, two models or two subsets can be measured side by side without interference.

## An experiment, not a script

The bench is a scientific instrument, and the rules below are what make its numbers
mean something. They are not ceremony; each one prevents a specific way of reporting a
result that is not true.

1. **Pre-registration.** `plan.json` is written before the first rollout and never
   rewritten: the subset (instance ids), the knobs, the turn budget, the hypothesis, the
   metric. A report that disagrees with its plan is a bug.
2. **One variable at a time.** A comparison changes exactly one knob. `moncho-cli bench compare`
   refuses a pair whose *controlled* variables differ — subset, model, agent ref, turns,
   grader — so a confounded difference can never be read as a finding.
3. **Resolved, not re-derived.** One `resolve_plan()` feeds `run`, `explain` and the
   manifest, so no document can describe a run other than the one performed.
4. **Recorded by source.** Every knob is captured as
   `{configured, default, effective, source}`, the shape
   `utils/context-size.js#resolveContextSize` already uses. This distinguishes "we left it
   alone" from "we set it to today's default" — which is what a default moving between
   agent versions would otherwise hide.
5. **Nothing secret.** Keys are recorded by name and presence, never by value.

Honest limit: recording the configuration buys **comparability**, not **causation**. Two
runs with an identical snapshot tell you the environment matched. Attributing a delta to
one variable needs the paired structure the metrics section describes.

## Layout of a bench

```
bench/
  Benchfile            the configuration: committed, no secrets
  .env.bench           the credentials: gitignored, sourced as shell
  .gitignore           ignores .env.bench, results/, node/, payload/
  plan.json            frozen at `select`, never rewritten
  results/
    index.jsonl        append-only ledger, one line per run
    <run-id>/
      manifest.json    identity: resolved plan, image digests, git revs
      config-snapshot.json   the knobs with their sources
      trials.jsonl     one record per instance attempt
      report.json      aggregates, machine-readable
      report.md        the writeup, human-readable
      instances/<id>/attempt-N/
        prompt.md      the exact prompt, as given
        stdout.log     what the agent printed
        context.json   the session record, copied out of the sandbox
        diff.patch     the model patch, extracted on the host
```

`results/index.jsonl` is what makes iteration cheap: comparing two runs reads two lines,
not two trees. `BENCH_RESULTS_DIR` relocates the whole ledger, so a sweep can be
collected somewhere other than the bench that produced it.

## `Benchfile`

Committed, shareable, and free of credentials.

```sh
# What this bench is.
BENCH_KIND="swe"                 # which kind under kinds/
BENCH_NAME="swe-lite"            # names the image, the results, the labels

# What it measures.
AGENT_REF="v0.31.0"              # the agent payload to run
AGENT_MODE="work"                # chat | design | work
TURNS="1"                        # cycles per instance (see "The loop")
TURNS_FOLLOWUP=""                # prompt used for cycles 2..N; empty = a default nudge
AGENT_TIMEOUT="1800"             # seconds per instance, the hard stop
STALL_CYCLES="3"                 # unproductive cycles before the run is a stall

# The subset.
SUBSET="lite"                    # lite | verified | dev
STRATIFY="repo"                  # how the sample is drawn from the subset
SAMPLE="40"                      # how many instances

# Grading and repeats.
RUNS="1"                         # attempts per instance (pass@k)
GRADE_WORKERS="8"
```

`.env.bench` is sourced exactly like `.env.moncho` — as shell, so quoting and comments
behave — and its values travel into the container as `-e NAME`, never `-e NAME=value`, so
a key never appears in the host process list.

```sh
OPENAI_BASE_URL="https://api.deepseek.com/v1/chat/completions"
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="deepseek/deepseek-v4.1-flash"
MODEL_TEMPERATURE="0"            # a bench pins this; taste is not a variable
CONTEXT_MAX_LENGTH="128000"
RUN_BASH_ALLOWED="python3,pytest,pip,git,ls,cat,grep,find,head,tail,wc"
```

## Commands

The framework is installed once by `bench/install.sh` (the `curl | bash` entry point), which
puts `moncho-bench` on your `PATH`. The agent's own CLI then reaches it as
`moncho-cli bench ...` (`docs/runtime/cli-subcommands`), which is how every command below
is spelled.

```
moncho-cli bench init --kind swe      write a bench in this directory
moncho-cli bench status [--json]      what this bench is, and where the last run got to
moncho-cli bench explain [--json]     the resolved recipe: the exact command a run would use
moncho-cli bench build                prepare the payload, the node runtime, the instance images
moncho-cli bench select               draw the subset and freeze plan.json
moncho-cli bench run [--instances …]  rollouts -> trials.jsonl
moncho-cli bench grade                the official harness over the model patches
moncho-cli bench report [--json]      resolved, pass@1, cost, and the reason for every miss
moncho-cli bench compare <a> <b>      two runs side by side, with the comparability guard
moncho-cli bench shell                a shell in the bench's instance image
moncho-cli bench clean [--images]     drop derived data; --images also drops the pulls
moncho-cli bench versions             list the installed framework revisions
```

`status` and `explain` are deterministic and local: they never call a provider. `status
--json` exists so a sweep or a plot can consume the same facts the operator reads.

## The loop, and why the bench owns it

Each cycle is **one `--exec` process**:

```
cycle 1        node main.js --exec .bench/prompt.md            # a fresh session
cycle 2..N     MONCHO_CONTINUE=1 node main.js --exec .bench/nudge.md
```

`MONCHO_CONTINUE=1` is the environment variable `main.js` reads; the runner's `--continue`
flag only sets it, and a bench invokes `main.js` directly. The bench supplies the
repetition, so the agent needs no self-drive and no `work:on` lock — which also means the
bench does not depend on the lock surviving a resume.

A cycle's progress is read from **two independent signals**, and a stall is *neither*
moving:

- the **workspace diff** (`git -C ws diff`), which needs no cooperation from the agent at
  all: if the model edited a file, this moves;
- the **checklist ticks**, counted with
  `utils/tracking-format.js#entriesOf`, which filters the seeded placeholder.

`task.md` is **telemetry, never the stopping rule**. The benchmark's truth is
`FAIL_TO_PASS`; a run that fixes the bug in one turn and never authors a checklist is a
*correct result*, and a bench that required one would score it zero. Two facts are
recorded so they are not rediscovered: `ensureTrackingFiles` seeds an entry reading
"(no items recorded)" that a naive parse counts as pending, and the agent's own work drive
stands down after two identical hand-outs.

A run that ends cleanly with an empty diff exits **0**. The report says "no patch", which
is a measurement; a non-zero code there would make a correct run look broken.

## Metrics

`resolved` is the benchmark's own verdict, from `FAIL_TO_PASS` and `PASS_TO_PASS` in the
official harness. Everything else is recorded because it explains a score:

| Metric | What it is, and why it is separate |
| ------ | ---------------------------------- |
| `pass@1` | resolved / attempted, with the sample size and a Wilson interval: 27 of 40 is not the claim that 270 of 400 is |
| `no_patch` | ended with an empty diff — the opposite fix from a wrong patch, so never merged with it |
| `stalled` | the guard fired with no diff and no tick |
| `tokens` | by class, per instance, read from the session's own usage block (`utils/session-format.js#sessionUsage`) so it survives a run that dies |
| `wall_clock` | per instance, including the cycles that produced nothing |
| `turns_used` | against the budget, which is how you learn whether more turns help |

At `MODEL_TEMPERATURE=0` repeat runs are near-deterministic, so `RUNS=1` usually suffices
and the interval is over *instances*. Where a provider proves nondeterministic, that is a
recorded finding rather than an assumption.

## SWE-bench Lite

The `swe` kind grades against the official harness. Two stages, deliberately:

1. **rollout** — in the instance's own SWE-bench image, so the environment is the one the
   benchmark pinned. The agent's runtime is a pinned `node` mounted read-only, not a
   rebuilt image, so the 300 instance images stay pristine and shared.
2. **grading** — `swebench.harness.run_evaluation` over `predictions.jsonl`. The harness
   applies the test patch and runs the tests; reimplementing that is how a benchmark
   becomes incomparable.

The patch is extracted **on the host**, with `git diff` against `base_commit`. The agent's
own state cannot be relocated out of the workspace (`utils/path-safety.js` refuses absolute
paths, so `SESSION_DIR` reads as unset), so its files are kept out of the patch by
`.git/info/exclude` — the same mechanism `bin/lib/git.sh` uses for a user's checkout.

Everything the agent needs to know about running the tests here travels as an `AGENTS.md`
at the workspace root, which reaches the model through the project-rules channel on every
request. The bench may describe **the measurement**; it must never instrument **the thing
measured**, which is why there is no `bench` tool in the agent's palette: adding one would
change the request shape, the allow-list and the trajectory, and the benchmark would then
be measuring a different agent from the one that ships.
