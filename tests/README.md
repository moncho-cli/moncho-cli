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
| `harness-tools.test.js` | The tool contract (`intent`), the read_file delimiters, the verified writes and the task.md protocol. |
| `tracking-format.test.js` | The canonical shape of both tracking files: the closed status set, the skeleton, the validator, the legacy upgrade, and the template the model is shown in the prompt and the tool description. |
| `tracking-store.test.js` | Where the pair lives: one folder per session, the file/record/root read order, the mirrored writes, and the seeding that never recreates the root files. |
| `tracking-fence.test.js` | Who may author them: a `write_file` draft re-rendered into the canonical document, and a `patch_file` into one refused as tool-owned. |
| `tracking-notice.test.js` | That an update is *visible*: the `[Tracking]` rows an item completion, a plan reset and a ticked step print, and the contrasting bright-green they are painted in. |
| `context-window.test.js` | The context machinery: token estimation, the 80/20 compaction, the live window and the `compact_context` tool. |
| `command-sandbox.test.js` | The sandbox rules: the allow-list, the shell-free refusals, and the structured npm failures. |
| `command-output-window.test.js` | A command result as a document: the YAML header, the `---` delimiter, the `head`/`tail` window, and the structured failure envelope. |
| `task-plan-progress.test.js` | `implementation_plan.md` moving as steps are verified: the step parsing, the strict selection, the in-place tick and the `step` action. |
| `tool-multicall.test.js` | The multicall grammar: the call signature, the `<tool-multicall result>` envelope, the round-trip and the replay of an enveloped chunk. |
| `tool-batch.test.js` | Running one batch: the five-call cap, the simultaneous dispatch in call order, the refusal, and the chunks the loop stores. |
| `patch.test.js` | Unified-diff application, its error codes and all-or-nothing behaviour. |
| `tui.test.js` | The blessed TUI layout, transcript rendering and pastes. |
| `tui-modules.test.js` | The TUI's extracted parts: the paste registry, the compaction notice, and the key bindings — interrupts and Tab taken pre-dispatch, scrolling on the screen. |
| `tui-status.test.js` | The status row: right-aligned context meter and spinner. |
| `transcript-blocks.test.js` | Collapsible tool output: the transcript model, clicks and toggles. |
| `interrupt-controls.test.js` | ESC / Ctrl+C semantics on both front ends. |
| `key-shapes.test.js` | What a key *is* before anything binds it: the decoder shapes of the interrupt pair and of Tab / Shift+Tab, and the two families staying disjoint. |
| `input-focus.test.js` | Keeping the input box armed: a click on another region never steals the caret, clicking the box re-arms it, and a periodic watchdog repairs a lost focus. |
| `ollama-provider.test.js` | Provider calls: system prompt injection, response normalisation, abort. |
| `conversation-manager.test.js` | The end-to-end loop against a stub provider. |
| `user-echo.test.js` | The user's own message: announced by the loop, rendered as a quote, never altered in the context. |
| `context-size.test.js` | Resolving the context size from config, provider or default. |
| `context-usage-refresh.test.js` | The live token meter: every window change and every call announces the usage, a broken listener is swallowed, and the compaction marker stays once-per-event. |
| `model-usage.test.js` | Token accounting per model: provider counters normalised from both shapes, the exact/estimated split, the session file's usage block, and `/usage`. |
| `call-pulse.test.js` | The model-call pulse as a value: the limit's default and its validation, the one-line wording before and past the cap, and the reasons a reset records. |
| `call-pulse-loop.test.js` | The pulse in the loop: the line rides every agent request right after the agent prompt, is never a chunk, the summariser does not tick it, and a completed item or a compaction resets it. |
| `brand.test.js` | The brand line: `MONCHO (v x.y.z)` formatted from the manifest, the one-row all-or-nothing fit rule, the reserved band, and the floating box in the top right of the conversation. |
| `queue-rows.test.js` | How a queued message is drawn: the cell counting (wide glyphs two, combining marks none), the preview budget that keeps the `✕ N. ` marker, and the rule that a row is fitted to the bar it is painted in. |
| `session-loop.test.js` | The host turn loop: the queue drained before the prompt, a command answered without a model call, an abort swallowed, and the task always torn down. |
| `turn-runner.test.js` | One turn against a stub provider: the request built from the window, the tool batch, and the three ways a turn can end (reply, abort, failure). |
| `session-mode.test.js` | The intent-mode machine: the cycle order, the `work:on` lock, the label and the colour per state, the `work` default against the `chat` junk fallback, and the round-trip through `toJSON()`. |
| `session-mode-label.test.js` | The mode painted on screen: the tag and the model in one row, a repaint on an accepted change only, and the state a session opens in. |
| `mode-controller.test.js` | Where a refused `Tab` goes: the `work:on` notice reaches the notice bar, the transcript is untouched, an accepted move stays silent, and a missing or throwing sink never costs the keystroke. |
| `mode-policy.test.js` | What each mode may do: the tool families, Chat read-only against Design's two tracking files, a shell refused where it cannot be scoped, the narrowed tool list, and the gate reading the live mode. |
| `tool-guard.test.js` | The pre-dispatch gate: no gate allows every call, a gate answer becomes a structured refusal, a throwing gate fails closed, and a refused call never invokes the tool. |
| `work-drive.test.js` | The `work:on` self-drive: the drive speaks only while the lock is on, hands the first pending item over, yields to a queued message, stops a finished checklist without releasing the lock, and stands down after a bounded number of identical hand-outs. |
| `work-command.test.js` | `/work on` and `/work off`: the lock refused over a missing, empty or finished checklist, the mode pinned to Work with the next item named, the release onto Design, and the live mode reached through the registry context. |
| `tui-teardown.test.js` | Closing the TUI and following a resize: the construction-reverse close that runs once, and the re-fit of every row measured at the old width. |

`tests/support/` holds shared harnesses (currently the TTY/TUI helper) that the
suites import; they are not test files themselves.

## Rules

1. A behaviour in the code is only proven when a spec names the case **by its exact
   test name** (`docs/<domain>/<capability>/spec.yaml`). Renaming a case is a docs
   change too — `docs-realm.test.js` fails otherwise.
2. Tests assert behaviour, not implementation details: they call the public
   functions and the real tools rather than reaching into private state.
3. A bug fix adds a case that fails before it and passes after.
4. Scratch scripts used to *explore* a task are not tests: they live in `agent/`
   (gitignored) and are deleted unless they stay genuinely reusable.
