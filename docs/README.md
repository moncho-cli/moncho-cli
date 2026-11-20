# docs/ — the behavioural spec realm

The project is made of **three realms** that must stay clear, factual and linked:

| Realm | Location | Role |
| --------- | --------------- | ------------------------------------------------------------------- |
| Code | `app/`, `api/`, `config/`, `tools/`, `utils/`, `main.js` | The ultimate truth: what the agent actually does. |
| Docs | `docs/` | What the code **must** do, and why. Behaviour, contracts, edge cases. |
| Tests | `tests/` | Executable proof that the code honours the docs. |

## The rules

1. **Docs never duplicate code.** A spec names behaviour and *references* the
   implementation as `path#symbol` (`utils/tool-schema.js#defineTool`). No copied
   algorithms, no restated function bodies, no line numbers.
2. **Code is the truth.** When a spec and the code disagree, one of them is a bug:
   fix the code or fix the spec, never leave the contradiction.
3. **Docs are the contract.** A new behaviour is not done until a spec describes it
   and a test in `tests/` proves it.
4. **Links are enforced, not promised.** `tests/docs-realm.test.js` fails when a
   spec is missing, a code reference points at a non-existent file/symbol, a test
   case named by a spec does not exist, or a source module is not covered by any
   spec.

## The path tree

The tree is semantic: `docs/<domain>/<capability>/`. A capability directory holds
exactly two files:

```
docs/<domain>/<capability>/
  behaviour.md   # the human-readable spec
  spec.yaml      # the machine-readable links (id, code refs, test refs)
```

Domains:

- `agent/` — the agent's tool contract and its sandboxing rules, including the lossy `hint_file` sketch next to the exact read (`agent/file-hint`), the bright row a refused call gets, worded like the chunk the model receives (`agent/tool-refusal`), and the rule that the stated approach seeds the turn, written once and grown from (`agent/approach-gate`).
- `context/` — the context window: token accounting (the live meter and the per-model totals), compaction, size resolution, the working-time counter the session adds up (`context/working-time`), and the per-call budget line (`context/call-pulse`) with its two resets.
- `interface/` — what the user sees and presses: TUI (including the per-block timestamps, `interface/conversation-timestamps`, the background band around each side of the dialogue, `interface/prose-bands`, and the aligned markdown tables of a reply, `interface/markdown-tables`), line CLI, interrupts.
- `runtime/` — provider calls and startup wiring.
- `maintainer/` — what a session owes the release: the version bump and how far it must go (`maintainer/version-bump`).

## `spec.yaml` format

The spec `id` **is** the path under `docs/` (`docs/<id>/`), so nothing is
duplicated. Quote a case name in YAML when it contains a colon.

```yaml
id: agent/tool-call-contract
domain: agent                    # first path segment of the id
title: Short human title
status: active                   # active | draft | deprecated
summary: >
  One paragraph: the behaviour this spec guarantees.
code:                            # every reference is path#symbol, repo-relative
  - path: utils/tool-schema.js
    symbols: [defineTool, getIntent]
tests:                           # test file + the exact case names that prove it
  - path: tests/harness-tools.test.js
    cases:
      - "every auto-loaded tool declares the required intent parameter"
```

`docs/index.yaml` lists every spec id plus the three realm roots; the linking test
compares that list against the spec directories actually present on disk.

## What is not a spec

Packaging is **not a fourth realm**: `bin/`, `scripts/`, the templates and the Makefile
are shell, so they sit outside the linking rule by design and are covered by
`make check-shell` plus `make probe` instead. The two entry points are worth naming
here, because the rest of this tree assumes them:

- a **user** installs once (`scripts/install.sh`) and then runs `moncho-cli` in any
  project directory; nothing is cloned;
- a **maintainer** works on this checkout through `./start.sh` (or `make dev`), and
  `moncho-cli` refuses to prepare the agent's own checkout as if it were a project.
