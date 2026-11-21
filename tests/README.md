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
| `tracking-format.test.js` | The canonical shape of both tracking files: the closed status set, the skeleton, the validator, the legacy upgrade, and the template the model is shown in the prompt and the tool description — the rule stated without a session path. |
| `tracking-store.test.js` | Where the pair lives: one folder per session, the file/record read order, the mirrored writes, and the fact that the project root is never a store — no root file is read, created or seeded. |
| `tracking-fence.test.js` | Who may author them, and where: `write_file` re-renders a draft only inside a session folder and refuses a tracking name at the root, while `edit_file` and `delete_file` refuse any tracking file as tool-owned. |
| `tracking-notice.test.js` | That an update is *visible*: the `[Tracking]` rows an item completion, a plan reset and a ticked step print, and the contrasting bright-green they are painted in. |
| `context-window.test.js` | The context machinery: the configurable-ratio compaction, the live window and the `compact_context` tool. |
| `token-accounting.test.js` | Character-based token estimation and budget reporting: additive estimates, the no-limit rule and the usage string. |
| `command-sandbox.test.js` | The sandbox rules: the allow-list, the shell-free refusals, and the structured npm failures. || `command-output-window.test.js` | A command result as a document: the YAML header, the `---` delimiter, the `head`/`tail` window, and the structured failure envelope. |
| `task-plan-progress.test.js` | `implementation_plan.md` moving as steps are verified: the step parsing, the strict selection, the in-place tick and the `step` action. |
| `tool-multicall.test.js` | The multicall grammar: the call signature, the `<tool-multicall result>` envelope, the round-trip and the replay of an enveloped chunk. |
| `tool-batch.test.js` | Running one batch: the five-call cap, the simultaneous dispatch in call order, the refusal, and the chunks the loop stores. |
| `approach-seed.test.js` | The stated approach as a value: prose is the whole test, the refusal and its reader row, the bound, and the wording the shipped prompt uses — the seed named for what it is, never an order about being first or a duty on every tool call. |
| `approach-gate.test.js` | The approach rule enforced: the seed is latched, a seedless message's calls are refused whole with one structured result per call, later batches of the seeded turn are ordinary, the seed rides the assistant chunk printed before the calls, and the bound lets the batch through without ever starving the turn. |
| `patch.test.js` | Unified-diff application, its error codes and all-or-nothing behaviour. |
| `edit.test.js` | Exact literal search/replace: literal matching, the two refusals with their evidence, order, all-or-nothing. |
| `edit-prompt-contract.test.js` | The read-before-edit rule as the model reads it in `config/prompt.md` §3.4: the exact read as the precondition, which sources are paraphrases rather than bytes, and the refusals and way out it names. |
| `edit-engine.test.js` | The pure edit engine and its miss diagnostics: literal matching, the candidate report, the bounds. |
| `tui.test.js` | The blessed TUI layout, transcript rendering and pastes. |
| `prose-bands.test.js` | The background band around each side of the dialogue: the two roles and their colours, the fill to the region's own width, the one-line margin (collapsed where two bands meet), and the fact that nothing else is banded. |
| `markdown-table.test.js` | A markdown table as aligned display rows: the delimiter-row rule that recognises one, the alignment it carries, the cell-based widths, and that a lone pipe stays prose. |
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
| `call-pulse.test.js` | The model-call pulse as a value: the limit's default and its validation, the one-line wording before and past the cap, the reasons a reset records, and the fact that the shipped prompt carries the behaviour rather than the machinery. |
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
| `tool-refusal.test.js` | A refused call as news for the reader: the `✖ Refused …` row, its bright-red bold palette kind, and the promise that the reader and the model are told the same reason. |
| `work-drive.test.js` | The `work:on` self-drive: the drive speaks only while the lock is on, hands the first pending item over, yields to a queued message, stops a finished checklist without releasing the lock, and stands down after a bounded number of identical hand-outs. |
| `work-command.test.js` | `/work on` and `/work off`: the lock refused over a missing, empty or finished checklist, the mode pinned to Work with the next item named, the release onto Design, and the live mode reached through the registry context. |
| `tui-teardown.test.js` | Closing the TUI and following a resize: the construction-reverse close that runs once, and the re-fit of every row measured at the old width. |
| `logging.test.js` | The operational log as a value: the three levels and the `warning`/`off` spellings, the threshold from the environment, the one-line record, the deterministic rotation chain, and a broken path that never throws. |
| `logging-sites.test.js` | The log at its real call sites: the turn-ending provider failure and the throwing tool are recorded through the registry without changing their outcome, an abort lands below an error threshold, and the path cannot escape the project. |
| `session-layout.test.js` | Where a conversation is written now that a session is a folder: the record is `context.json` beside its `task.md` and plan, a flat `<id>.json` from the older layout is still read (the folder wins when both exist), the next save retires it, and the explicit migration moves it byte for byte. |
| `version-bump.test.js` | The version a maintainer moves before a release: the semver arithmetic, the one-step-is-enough rule, the manifest and the lockfile moving together, the guide that states it, and the guard that keeps it out of the shipped agent prompt. |
| `compact-command.test.js` | The `/compact [force]` slash command: the ordinary budget check, the forced compaction that restarts the pulse, and the refusals. |
| `stale-read.test.js` | The stale-read guard: a read is fingerprinted, a write or patch into a file that changed since is refused with `STALE_READ`, and a never-read or brand-new file is written as before. |
| `clipboard-selection.test.js` | Selecting text in the conversation: the release and cell points, the cluster-exact extraction, and the rule that a plain click still toggles a block. |
| `clipboard-mouse-wire.test.js` | The gesture driven by the bytes a real terminal sends (SGR reports): a drag arrives as repeated `mousedown`, so it must extend rather than restart, and a release outside the pane must still finish it — the two bugs the synthetic-action suites could not see. |
| `clipboard-file.test.js` | The copy end: a selection becomes a time-stamped file in the workspace (`.moncho.clipboard.HHMMSS`), a second copy in the same second gets its own name instead of overwriting, and a failed write is reported rather than thrown. |
| `clipboard-watch.test.js` | The host-side pickup (`bin/lib/clipboard-watch.sh`): the tool chosen per platform (`pbcopy` / `clip.exe` / `wl-copy` / `xclip` / `xsel`), a new selection fed to it exactly once, a stale file left alone so starting the agent never clobbers the clipboard, an ordinary file ignored, and `stop` really ending the watcher. Drives the real script against a fake clipboard tool, so the assertion is on the bytes the tool received. |
| `clipboard-highlight.test.js` | The reverse-video mark over exactly the selected cells, spliced at a cell boundary through the line's own tags. |
| `clipboard-selection-tui.test.js` | The whole gesture through a real screen: a release saves a file and a plain click still toggles a block, a wrapped line is saved from the line it started on, and the confirmation is a top-right toast naming the file, never a row in the conversation. |
| `toast.test.js` | The copy confirmation model: the two sentences a copy can say (a proven one and a sent one), four seconds, a second copy replacing the first, and a blank message not being a toast. |
| `tui-toast.test.js` | The toast box itself: top-right, only as wide as its sentence, and hidden by its own timer. |
| `slash-autocomplete.test.js` | The slash-command popup: the query a leading `/` stands for, the name-only ranking (a prefix, then a subsequence, never the description), the cell-fitted rows, the two accept paths (Tab completes, Enter runs), and the live arbitration of the arrows and Enter. |
| `slash-popup-screen.test.js` | The same popup on a real screen: the blue band that marks the selected row (filled to the bar's interior width, and the literal `{inverse}` it replaced), and the whole gesture — filter, arrows, Tab, Enter — through blessed. |
| `host-fence.test.js` | The paths a host executes rather than reads: git hooks, `.git/config` (which redirects the hook directory) and `.env.moncho` (which the runner sources as shell). The classifier is segment-based so a spelling change cannot slip past it; all three writers refuse, and an ordinary file in the same tree is untouched. |
| `container-mount.test.js` | The mount boundary the fence's refusals rest on: in bind mode `.git` and `.env.moncho` are shadowed read-only (a nested mount wins over its parent), `GIT_OPTIONAL_LOCKS=0` is set, and a path that does not exist gets no shadow. Sources the real `bin/lib/container.sh`, so the assertion is on the arguments docker would receive. |

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
