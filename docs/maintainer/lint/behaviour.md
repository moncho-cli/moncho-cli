# The static gate every other check leaves open

`npm test` is the project's proof, and it is entirely **runtime**. That is the right
default — these suites assert behaviour through the public functions rather than reaching
into private state — but it leaves one class of defect invisible: a fault that can only
fail on a path a test happens to execute is a fault no test will find if no test walks it.

This repository shipped exactly that.

## The defect that motivated the gate

`main.js` passed `skinSubchat` into the mid-turn command runner as a shorthand property
inside the runner's `run` closure, but only ever bound the name as an **object property**
given to `runSessionLoop`. A property is not a binding. So the closure referenced an
identifier the file never declared, every mid-turn command threw `skinSubchat is not
defined`, and it read as a timing problem because it only happened mid-turn.

Every suite passed. The reason is worth stating plainly, because it is the whole argument
for this spec: **each mid-turn test injects its own stand-in `run`**, so none of them ever
evaluates the host's closure. The one guard that did exist,
`tests/busy-command-wiring.test.js`, reads `main.js` as text and refuses the exact shape
that broke — a regex over one file for one bug, which cannot see the same mistake in any
other closure.

An undeclared identifier is knowable **without running anything**. That is what makes this
a linter's job and not a test's.

## Two rules, and not a preset

The config is `eslint.config.js`, and the split between its two rules is the design.

| Rule | Severity | Why |
| ---- | -------- | --- |
| `no-undef` | **error** | "Is this name declared?" has one right answer and no style judgement behind it. A tree with an undeclared name is broken, not untidy. |
| `no-unused-vars` | **warn** | The inverse question, and a much weaker one — see below. |

`no-undef` can be an **error** at all because the tree already satisfies it. The
measurement that chose this config found **zero** hits across 349 files, so adopting it
rewrote nothing. A gate that requires a mass rewrite to switch on is a rewrite project
wearing a gate's clothes; this one cost a config file.

`no-unused-vars` must be a **warning** because the tree carries dozens of legitimate hits: a
re-export barrel and a test's convenience import are both "unused" to a static reader. It is
still worth seeing, so it prints — 58 warnings today, none of them blocking.

### What was measured and rejected

`js.configs.recommended` was tried first and left out, with its numbers, because
"recommended" here means a mass rewrite rather than a check: it adds **81 errors** to this
tree.

- **Most** are `no-control-regex` on the `\x1b` escape bytes the TUI suites match on
  purpose. The byte *is* what they test. Silencing a rule that many times is how a config
  becomes noise nobody reads.
- **Six** are real: `no-useless-assignment` in `tools/update_task.js`,
  `utils/chunk-meta.js`, `utils/chunkpaction-store.js`, `utils/conversation-log-store.js`,
  `utils/edit-miss.js` and `utils/patch_lib.js`, and `no-unreachable` in
  `utils/task-pulse.js`. They deserve their own change with their own tests rather than a
  ride along with a linter. Turning those two rules on is the obvious next step; it is
  deliberately not this one.

## What is linted, and what is not

The config covers every `.js` and `.mjs` under the project, and ignores three trees on
purpose:

- **`agent/`** is scratch and gitignored — it does not ship, so linting it measures
  something that is not the project;
- **`vendor/`** is a second copy of a published package, kept for the container build;
- **`build/`** and **`node_modules/`** are outputs.

The globals come from `globals.node` rather than a hand-written list, because a hand-written
list is a second place to forget `process` after `Buffer`.

**`node --check` stays the cheap per-file gate.** It parses one file with no dependency
installed; this config answers the questions a single-file parse cannot (a name resolved
against the module scope, a binding that is never read) and needs the dependency to do it.
The two are not substitutes, and the build keeps both.

## The command

```
npm run lint      # eslint .
make lint         # the same command, for CI and the agent to share
```

`make lint` exists so CI and the agent run **one** spelling of the command, which is the
failure this repository has already paid for once in the packaging realm: two entry points
that drift apart are two behaviours.

## What the code does

- `eslint.config.js` — the flat config: the two rules, their severities, the ignored trees
  and the node globals, with the measurement behind each choice written beside it.
- `package.json` — the `lint` script, beside `test`.
- `Makefile` — the `lint` target that wraps it for CI.