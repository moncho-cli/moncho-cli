# The maintainer flow's own rules

`config/prompt.md` is the system prompt of **every** install. `scripts/install.sh` copies it
into `~/.config/moncho-cli/`, and `bin/lib/image.sh` bakes it into `moncho-agent`, so the
session reading it usually stands in *someone else's* project.

That makes a rule about **this** tree advice about a repository the session is not in. The
version-bump bookkeeping already stays out of the prompt for exactly this reason
(`docs/maintainer/version-bump`, proved in `tests/version-bump.test.js`), and
`tests/mode-policy.test.js` states the principle for the modes: an instruction about a state
the model cannot observe is prose it has to ignore.

## What the maintainer flow needs

A maintainer runs the agent against this very checkout (`./start.sh`, `MONCHO_MAINTAINER=1`)
and reads every diff. So:

- **the repository is theirs** — the model does not commit and does not stage. A commit the
  model makes is a commit *the maintainer did not make*, in their voice, under their name,
  arriving before they have read a line of the change;
- **the working tree is the model's** — it still edits files, and `git stash` is available
  when debugging a test needs a clean tree, with the tree put back before it finishes;
- **reading is how it checks its own work** — `status`, `log`, `diff`, `show`, `blame` are
  all unrestricted, and the rule says so, because a rule that only forbids teaches the model
  to stop reading the repository.

## The rule is a fragment, appended only in the maintainer flow

The rule lives in `config/maintainer-prompt.md` and is concatenated at the **end** of the
prompt by `api/ollama.js#maintainerGuidance`, which answers `''` unless
`config/constants.js#maintainerMode` says the tree is the maintainer's own.

So the always-sent prompt is untouched, and a user flow gets the rule only by stating it in
its own `AGENTS.md` — which is the channel that already exists for a project's own rules
(`docs/agent/project-rules`). That is the split: **the agent's rules stay in `prompt.md`, and
the repository's rules arrive from the repository.**

Three properties the seam keeps, each inherited from a neighbour rather than invented:

- **absence is silence.** No fragment, an empty one or an unreadable one answers `''`, so the
  request goes out exactly as it did before the fragment existed — the contract
  `utils/project-rules.js` keeps.
- **read at call time, not at import.** The suite runs *inside* the maintainer's container,
  where the switch is ambient, which is why `config/constants.js#hostFenceEnabled` reads late;
  a fragment decided at import would make both sides of the behaviour untestable.
- **named for the question it asks.** `maintainerMode()` and `hostFenceEnabled()` are inverses
  by construction but named separately: one asks *whose checkout is this?*, the other *should
  the host fence apply?* — a question about paths. A later change to one cannot silently move
  the other.

## What this is not

It is a **prompt rule, not enforcement**: the model is asked, not stopped. That is a
deliberate, proportionate choice — the maintainer reads every diff, and the rule is one
sentence of prose rather than a mechanism. It is worth saying plainly, though, because the
failure mode is real: a model that is *asked* not to commit will sometimes commit anyway,
and the failure is quiet, since a commit looks like progress. A maintainer who wants the
guarantee needs a check outside the model, which this is not.

## What the code does

- `api/ollama.js#maintainerGuidance` — reads the fragment, trims it, and returns it
  introduced by a blank line; `''` for a disabled flow, a missing file or an empty one. The
  fragment path is a parameter so the absence rule is provable against a file that really
  does not exist, rather than by deleting the shipped one.
- `config/constants.js#maintainerMode` — the switch, read at call time.
- `config/maintainer-prompt.md` — the prose itself, which the maintainer can read and edit.
