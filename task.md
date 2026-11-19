status: done — 26/26 items and all six acceptance criteria verified, plus the Chat claim corrected to "no writing tool is offered or may run" (the session record the host writes in every mode is not a tool); 413/413 green

# Stateful mode isolation: Chat / Design / Work, under a session-scoped execution lock

The backlog item (`agent/tmp/mode-isolation.md`, recorded in `task-backlog.md`):

> Most CLI agents blur the line between talking about code and mutating code — a
> casual question like *"how would we refactor this?"* can accidentally trigger file
> edits. To prevent this while still supporting autonomous execution, the system
> separates **Intent Modes** (`Chat` and `Design`) from **Execution State**
> (`Work:on` / `Work:off`).

## The model to build

| Concept | Meaning |
| ------- | ------- |
| **Intent mode** | `Chat` (no writing tool), `Design` (authors `task.md`), `Work` (executes it) |
| **Execution state** | `work:on` / `work:off` — a *lock*, not a mode: while `work:on` the intent mode cannot change |
| **Session scope** | every session carries its own mode; a session in `Chat` runs no tool that writes (its own session record is written by the host) |

The contract, restated so each item below can be judged against it:

- A fresh session opens in **`Work`** (`DEFAULT_MODE`); `Tab` moves
  `Chat -> Design -> Work`, and the move is **blocked while `work:on`**.
- A mode is a **policy in two halves**: the tool list *advertised* to the provider is
  narrowed, **and** every call still passes the pre-dispatch gate. The list is an
  invitation, the gate is the guarantee — narrowing alone is not "Chat cannot write".
- `/work on` needs a `task.md` with at least one pending item; it locks the session to
  `Work` and sets it **self-driving**. `/work off` stops it and falls back to
  `Design`.
- The current state is a **coloured label at the leftmost cell of the model row**, one
  bright colour per state.
- While `work:on` the session stays reachable: chat messages steer it, and hot-editing
  `task.md` is an explicit senior escape hatch, never a guarantee.
- The main agent answers questions about progress by reading `task.md` /
  `implementation_plan.md`.

## The execution shape — decided: foreground, not a second agent

`work:on` makes the session **take its next prompt from its own `task.md` instead of
the keyboard**, inside the same conversation: one `ContextWindow`, one transcript, one
session file. The seam already exists — `app/session-loop.js:133` takes every prompt
from `nextPrompt({ dequeue, ask })`, so the driver is a different `ask`, not a
different application.

**A separately spawned background agent, and the `Alt+N` view switching that went with
it, are dropped.** Reasons, in order of weight:

1. `utils/host.js` keeps **one** registered `contextWindow` and **one** `taskPulse`,
   and `ConversationManager`'s constructor registers both
   (`app/conversation-manager.js:82-83`). A second manager for a worker would
   **silently steal** them, so `compact_context` and `update_task` would then act on
   the worker's window and pulse. A worker requires per-session registry scoping
   first — a change to a shared, tested utility that every spec assumes is a
   singleton.
2. The work product is already shared: `task.md` and `implementation_plan.md` on
   disk. A second transcript buys concurrency of *attention*, not of *result*.
3. Cost: the foreground shape is ~5 modules touched with existing, tested seams
   (`main.js`, `app/session-loop.js`, `app/tui-keys.js`, the command registry, plus one
   new pure policy module). The worker adds a second window, abort manager, usage
   meter, session file and transcript, plus a driver protocol — and `app/tui.js` is at
   **295/300 lines**, so that work would force a split mid-feature.

What is given up, honestly: no true concurrency (you cannot plan the next item while
the session commits the current one), and the watcher shrinks into "the driver reports
each completed step" rather than a timer polling a phantom agent.

## Research log — the audit of this branch (steps actually run)

The branch is the **staged 39-file change set** on `main` (nothing committed yet), so
the audit read `git diff --cached`, not a commit range.

1. `git log --oneline -25` / `git status` / `git diff --cached --stat`
   → 39 files staged: 4 refactors + `app/session-mode.js` + `app/session-mode-label.js`
     + `app/work-*` **absent**; 23 files touched under `app/`/`main.js`, 16 under
     `docs/`/`tests/`/`task*.md`.
2. `npm test` → **371/371 pass, 0 fail** before any change: the baseline is green, so
   every later failure is ours.
3. Read the new modules whole: `app/session-mode.js`, `app/session-mode-label.js`,
   `app/session-loop.js`, `app/tool-guard.js`, `app/turn-runner.js`, `app/tui-teardown.js`
   and the modified `app/tui.js`, `app/tui-layout.js`, `app/tui-surface.js`,
   `app/prompt-input.js`, `app/conversation-manager.js`, `app/tool-batch.js`, `main.js`.
4. `grep 'cycle\(|setWork|createSessionMode|WORK_LOCK_NOTICE'` → 7 files, and they are
   the machine itself, its tests, its docs and `implementation_plan.md`. **No production
   caller drives the mode**: the feature is unreachable.
5. `grep 'toolGate|allowAllGate|TOOL_REFUSED_BY_MODE'` → `app/conversation-manager.js`
   reads `options.toolGate` and forwards it, `app/tool-guard.js` implements the rules;
   nothing ever passes a gate, so `allowAllGate` (null) is what ships. **Chat is not
   read-only**: no call is refused and no tool list is narrowed.
6. `grep -i 'tab|alt'` across `app/` → **no `Tab` and no `Alt+N` binding exists**;
   `app/tui-keys.js` binds interrupts and scrolling only.
7. `grep 'session-commands|work-agent|work-watch'` → `app/session-mode.js:16` cited
   `app/session-commands.js`, **a file that does not exist**, and `docs/interface/modes`
   stated the `Tab` binding and `/work on|off` as current behaviour. Docs contradicted code.
8. `wc -l` on the touched files → `app/tui.js` **295** of a 300 target, `app/tool-batch.js`
   270, `app/conversation-manager.js` 250, `app/session-mode.js` 187,
   `app/session-mode-label.js` 112. The Tab binding cannot land in `app/tui.js`.
9. Read the two dependency sources the binding depends on:
   - `node_modules/neo-blessed/lib/widgets/textarea.js#_listener` appends any `ch` not
     matching `/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/`, and `\x09` (Tab) is **not**
     excluded → a plain `screen.on('keypress')` binding both fires *and* types a tab
     into the prompt.
   - `node_modules/neo-blessed/lib/widgets/screen.js:583-604` → the program listener runs
     before the focused widget and screen dispatch is skipped when `screen.lockKeys` is
     set, which is the seam `app/tui-keys.js` already uses for the interrupt.
10. `grep '\bmode\b' utils/session-store.js` → no mode field in the session file, so
    `toJSON()` has no consumer: `/sessions` cannot restore a mode today.

### Follow-up steps — the contract (F3), then the execution shape

11. Re-read `agent/tmp/mode-isolation.md` against `docs/interface/modes` and `task.md`
    → the note's prose calls `Chat`/`Design` the *interactive* modes and `Work` the
    executing one, but it never says which one a session *opens* in. The "default is
    chat" reading came from `createSessionMode({ mode = MODES.CHAT })` alone, so the
    default was an accident of the constructor, not a stated contract. The user's
    request settled it: a session opens in `work`.
12. `grep 'session-commands|work-agent|work-watch'` again before editing → the only stale
    reference was `app/session-mode.js:16`, fixed in the same change.
13. Applied the default change as one atomic set (`app/session-mode.js`,
    `app/session-mode-label.js`, `docs/interface/modes`, the three affected suites):
    `DEFAULT_MODE = MODES.WORK`, `createSessionMode({ mode = DEFAULT_MODE })`,
    `defaultModeState()`/`formatModeTag()` following `DEFAULT_MODE`, and
    `normalizeMode()` **left on `chat`** with a comment saying why the two rules differ.
14. `npm test` → **373/373 pass, 0 fail** (was 371/371: two new cases). The eight failures
    the change first caused were exactly the assertions pinning the old `chat` default,
    which is the audit's own evidence that the default was load-bearing.
15. Sized the execution shape before building it: `tools/` holds nine tools
    (`read_file`, `blob`, `grep`, `compact_context`, `write_file`, `patch_file`,
    `update_task`, `run_bash`, `run_npm`), `main.js:102` owns `const getTools = () =>
    tools` and `app/turn-runner.js:82` calls it once per request → **half 1 of the
    policy needs no new seam**; `app/conversation-manager.js:60,221` already forwards
    `options.toolGate` into the batch → **half 2 is one line of wiring**.
16. Confirmed the blocker on the background variant: `utils/host.js` is a single-slot
    registry (steps 15, `app/conversation-manager.js:82-83`), and
    `app/session-loop.js:133` takes prompts from `nextPrompt({ dequeue, ask })` →
    the foreground driver is a different `ask`, the worker is a second application.
    The user confirmed the foreground shape.

### Findings the audit settled

| # | Finding | Evidence |
| - | ------- | -------- |
| F1 | `Tab` is not bound; the modes cannot be reached by key at all | step 6 |
| F2 | The app never builds a `createSessionMode()`, so the label paints the static default | steps 4, 7 |
| F3 | The default was `chat` in code and docs, the request is `work` — a **contract conflict**, not a bug | step 3, `docs/interface/modes` |
| F4 | `/work on|/work off` do not exist; `/work on` answers "Unknown command /work" | `app/commands.js#createDefaultCommands` ships `/sessions`, `/usage`, `/help` |
| F5 | The mode gate is a dead seam: written, tested, installed nowhere | step 5 |
| F6 | No `Tab`, no `/work`, no per-mode tool list, no self-drive | steps 4-7 |
| F7 | 2 files were added without a trailing newline | `app/tui-teardown.js`, `docs/agent/tool-multicall/spec.yaml` |
| F8 | The branch's new suites had no `tests/README.md` row | step 7 |

### Closed by the follow-up

| # | What changed | Verification |
| - | ------------ | ------------ |
| F3 | the default is `work` (`DEFAULT_MODE`) while the junk fallback stays `chat`, documented as two deliberately different rules | steps 13, 14 |
| F2 | `defaultModeState()` follows `DEFAULT_MODE` instead of hard-coding `chat`, so the row and the session cannot disagree | step 13 |
| F7, F8 | the two missing trailing newlines are in place, and the six suites this branch added have their `tests/README.md` rows | this change, `npm test` |
| — | the stale `app/session-commands.js` reference is gone (it now points at the command registry) | step 12 |
| F6 | restated: the execution shape is **decided** (foreground self-drive), so the remaining work is the wiring below | steps 15, 16 |

## Items — refactors first, then the feature, then the proof

- [x] refactor: extract the host turn loop out of main.js into app/session-loop.js, so main.js stays a wiring module under the size budget
- [x] refactor: split app/conversation-manager.js by moving one-turn execution (request, tool batch, final response) into app/turn-runner.js
- [x] refactor: trim app/tui.js by extracting teardown and the resize repaint into app/tui-teardown.js, leaving room for the mode wiring
- [x] refactor: give app/tool-batch.js a pre-dispatch call gate, extracted into app/tool-guard.js so the batch stays under the size budget
- [x] app/session-mode.js: the pure Chat/Design/Work state machine — cycle order, the work lock rules, the label text and the per-state colours
- [x] interface: paint the current mode as a coloured label at the leftmost of the model row, refreshed on every mode change
- [x] research: audit the staged branch against the four user-visible expectations (Tab, default mode, the loop doing work, `/work on|off`) and record the steps and the findings (steps 1-10, F1-F8)
- [x] contract: a fresh session opens in `work` (`DEFAULT_MODE`) while a junk stored mode still falls back to `chat` — code, `docs/interface/modes` and the affected suites changed together (steps 11-14)
- [x] contract: the execution shape is the **foreground self-drive** — one conversation, one window, one transcript, one session file; the background `app/work-agent.js` and `Alt+N` view switching are dropped (steps 15, 16)
- [x] interface: an `isTabKey()` helper beside `isInterruptKey()` in `utils/keys.js`, so the key is decided in one pure place
- [x] interface: bind Tab in `app/tui-keys.js` **pre-dispatch** — the program listener plus `screen.lockKeys` for that one event, never a plain `screen.on('keypress')` (step 9)
- [x] interface: the binding calls `sessionMode.cycle()`, and a refused cycle routes `WORK_LOCK_NOTICE` to the TUI notice bar (`app/notice-bar.js`) / a plain line in the line CLI — never to the transcript
- [x] agent: `app/mode-policy.js` — the pure policy, `toolsForMode(mode, tools)` and `gateForMode(mode)`: Chat keeps the read-only set (`read_file`, `blob`, `grep`, `compact_context`), Design adds the writers restricted to `task.md` and `implementation_plan.md`, Work is unrestricted (note: `run_bash`/`run_npm` are **not** read-only and are refused in Chat)
- [x] agent: install both halves in `main.js` — a mode-aware `getTools()` (half 1) and `options.toolGate` (half 2), so `app/tool-guard.js` stops being a dead seam (F5, steps 15)
- [x] agent: a refused call answers as the structured `TOOL_REFUSED_BY_MODE` chunk naming the mode, instead of touching a file
- [x] interface: `/work on` and `/work off` in the command registry (`app/commands.js`) — `on` refuses a session with no `task.md` or with every item done, then engages the lock; `off` releases it and falls back to Design
- [x] runtime: the `work:on` self-drive in `app/session-loop.js` — while the lock is on, `ask` returns the next step derived from `task.md` instead of `cli.question`, so the session walks the checklist item by item in its own conversation (step 16)
- [x] sessions: persist the mode and the lock with the session file (`utils/session-store.js`) and restore them on `/sessions`, so a resumed conversation keeps its state
- [x] docs: register `app/mode-policy.js` in a spec (it belongs to `docs/interface/modes`, whose `code:` list already owns the machine and the label), add the new suites' `tests/README.md` rows, and note the mode rules in `prompt.md`
- [x] verify: `npm test` green, every touched file under 300 lines, and the whole flow rehearsed once end to end

## Done when — acceptance criteria

- [x] `Chat` provably cannot write: with the mode on Chat, no mutating tool is offered
      to the provider **and** a mutating call the model still makes is refused by code
      with a structured answer naming the mode.
      *Proof:* `tests/mode-policy.test.js` — "Chat is read-only: every writer is refused
      and every reader is allowed", "toolsForMode narrows the list the provider is
      offered", "a Chat turn advertises the read-only list and refuses the write the
      model still names". Rehearsed end to end: Chat was offered only `blob,
      compact_context, grep, read_file`, and `write_file` / `run_bash` came back as
      `chat:TOOL_REFUSED_BY_MODE`.
      "No mutating tool" is the exact claim: the session record the host writes in every
      mode is not a tool and no mode gates it (`docs/runtime/session-store`).
- [x] `Design`'s only writes are `task.md` and `implementation_plan.md`.
      *Proof:* `tests/mode-policy.test.js` — "Design writes the two tracking files and
      nothing else"; the rehearsal saw a write to `app/demo.js` refused in Design.
- [x] `Tab` walks the three intent modes, the label changes colour with it, and
      neither Tab nor `/work off` can leave the Work lock without `work:off`.
      *Proof:* `tests/session-mode.test.js` ("Tab cycles the three intent modes and
      announces every change once", "the work lock refuses Tab and any mode change, and
      explains itself"), `tests/session-mode-label.test.js` ("the state key, the label and
      one bright colour per state", "Tab in the real TUI moves the mode and never types
      into the input box"), `tests/mode-controller.test.js` ("Tab against a locked session
      shows the refusal in the notice bar, never the transcript"),
      `tests/tui-modules.test.js` ("bindKeys() takes interrupts and Tab before blessed
      dispatches, and scrolls from the screen").
- [x] `/work on` refuses a session with no `task.md` or with every item already done.
      *Proof:* `tests/work-command.test.js` — "/work on refuses a session with no task.md,
      and the mode does not move" and "/work on refuses an empty checklist and one whose
      items are all done".
- [x] With `work:on` the session drives itself through `task.md` one item at a time in
      its own conversation (it is not a second agent), the main agent reports status
      from the tracking files, and a chat message typed mid-run still steers it.
      *Proof:* `tests/work-drive.test.js` — "the drive hands over the first pending item
      while the lock is on", "runSessionLoop() runs the driven prompt as one normal turn,
      then the keyboard again", "a queued message still steers the drive: the queue is
      drained first". The drive is a different `ask` (`app/work-drive.js` reads `task.md`
      and names the item verbatim), never a second manager, window or session file.
- [x] Every touched file stays under 300 lines and `npm test` is green.
      *Proof:* every `.js` file under `app/`, `utils/`, `tools/`, `tests/`, `api/`,
      `config/` and the root was scanned — none exceeds 300 lines; `node --test
      "tests/**/*.test.js"` → **413/413 pass, 0 fail** (the Chat save case included).

## Notes

- **The Chat guarantee is now stated at its real width.** "`chat` creates no file at
  all" was false: the session recorder is host code and writes after every turn in
  every mode, so the honest claim is *no tool that writes to the project tree is
  offered or may run* — a shell included, refused in `chat` and `design` both. The
  wording was corrected in `docs/interface/modes`, `docs/runtime/session-store`,
  `app/mode-policy.js` and here, and `tests/session-loop.test.js` proves the session
  record is written in Chat too, so the narrower claim cannot rot back into the wider.

- The five refactor items came first on purpose: `main.js` (249 lines),
  `app/conversation-manager.js` (287), `app/tui.js` (289) and `app/tool-batch.js` (254)
  all sat close to the 300-line budget, and the mode wiring is what would push them
  over. Each refactor is behaviour-preserving and is verified by the existing suite.
- **The branch was a foundation and is now a feature.** The machine, the label and the
  gate came first; `Tab` (`app/tui-keys.js`, pre-dispatch), `/work on|off`
  (`app/work-command.js`), the live per-mode tool list, the gate, the self-drive
  (`app/work-drive.js`) and the persistence (`app/session-mode.js#restore`) followed.
  The one honest limit left is the F2 note below, now a *scope* statement rather than a
  gap: the guarantee is the advertised list plus the gate over **tool calls**, and every
  write path a tool could take (a shell, a stray `writeFile`) is either refused by the
  gate or not offered at all. What "read-only" cannot mean is "nothing lands on disk":
  the host saves its own session record in every mode (`docs/runtime/session-store`).
- **F2 is closed for the tool surface:** the shell is handled — `run_bash` / `run_npm`
  are refused in Chat *and* Design and advertised in neither — so no tool path is left
  unguarded. An absolute "no write of any kind" would be a claim about the host too,
  and the host is meant to write: the session record is the one file a Chat session
  leaves behind, by design.
- The mode state machine is pure and lives outside the TUI, so both front ends share
  it; the line CLI (no `Tab`, no coloured label) still honours the gating rules.
- `work:on` is a lock, never a sandbox: live steering and hot-edits stay available by
  design, and the clean workflow remains `work:off` -> Design -> `work:on`.
- `app/tui.js` is at **295 lines**, so the mode keys go in `app/tui-keys.js` and the
  per-mode policy lives in its own pure module: the budget forces the split, not taste.
- **Everything is wired now** (`main.js`): one `createSessionMode()` feeds `createTui({ mode,
  onCycleMode })`, `getTools()`, `toolGate`, `createSessionRecorder({ stateOf })`, the
  `/work` command context and the `work:on` drive. The mode is also persisted with the
  session and restored on `/sessions` (`app/session-mode.js#restore`).
