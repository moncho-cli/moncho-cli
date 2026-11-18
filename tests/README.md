# tests/ — the proof realm

These are the executable checks that the **code honours the docs** (see
`docs/README.md` for the three realms). Code is the truth, docs are the contract,
and this directory is the evidence.

## Running

```
npm test
```

Node's built-in test runner runs every `tests/**/*.test.js` file. Each file is
self-contained: it creates its own temp working directory (or stub provider) and
does not need the network.

## Layout

Suites are named after the capability they prove, mirroring the `docs/` tree:

| Suite | Proves |
| -------------------------------- | ----------------------------------------------------------- |
| `docs-realm.test.js` | The three realms are linked: every spec exists, its code refs resolve to real symbols, its named cases exist, every source module is documented. |
| `harness-tools.test.js` | The agent tool contract and the context machinery (tools, sandbox, token accounting, compaction, task protocol). |
| `patch.test.js` | Unified-diff application, its error codes and all-or-nothing behaviour. |
| `tui.test.js` | The blessed TUI layout, rendering, status bar and spinner. |
| `interrupt-controls.test.js` | ESC / Ctrl+C semantics on both front ends. |
| `ollama-provider.test.js` | Provider calls: system prompt injection, response normalisation, abort. |
| `conversation-manager.test.js` | The end-to-end loop against a stub provider. |
| `context-size.test.js` | Resolving the context size from config, provider or default. |

## Rules

1. A behaviour in the code is only proven when a spec names the case **by its exact
   test name** (`docs/<domain>/<capability>/spec.yaml`). Renaming a case is a docs
   change too — `docs-realm.test.js` fails otherwise.
2. Tests assert behaviour, not implementation details: they call the public
   functions and the real tools rather than reaching into private state.
3. A bug fix adds a case that fails before it and passes after.
4. Scratch scripts used to *explore* a task are not tests: they live in `agent/`
   (gitignored) and are deleted unless they stay genuinely reusable.
