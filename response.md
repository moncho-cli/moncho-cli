## Review

`implementation_plan.md` describes the plan for `task.md` item 2 (ESC / Ctrl+C cancellation + exit). Every checkbox in the plan is still `[ ]`, but the code tells a more granular story — roughly **2 of 6 steps are done, 1 partial, 3 not started**.

### Done (verified)

**Step 1 — `utils/keys.js`** ✅
- File exists (29 lines) with a documented rationale for the three decoder shapes, exporting `ESCAPE_CHAR`, `CTRL_C_CHAR`, `isEscapeKey()`, `isCtrlC()`, `isInterruptKey()`.
- `node --check utils/keys.js` clean.
- Caveat: it is **only consumed by `app/abort-manager.js`** — the "shared" predicate is not yet shared with the TUI/CLI readers it was written for.

**Step 2 — `AbortManager`** ✅ (module level)
- Single `interrupt()` entry point: `confirming → cancelActiveTask()`, `!hasActiveTask → requestExit()`, else `requestCancel()` ✓
- `requestCancel()` with both modes (`'prompt'` for the line CLI via `rl.question`, `'keys'` for the TUI) and double-press escalation ✓
- readline interface `'SIGINT'` listener + `process.on('SIGINT')` fallback, with the Ctrl+C double-fire guard (`if (this.#rlSigintHandler && isCtrlC(...)) return`) ✓
- `hasActiveTask`, `requestExit()`, `dispose()` ✓
- Probes agree: `node probe-abort-keys.mjs` → *"OK: no duplicate stdin listener in TUI mode"*; `node probe-cli-keys2.mjs` → `rl SIGINT` is delivered while a task runs.

### Partial

**Step 6 — verification** ⚠️
- `npm test` → **82 pass / 0 fail**; `node --check` clean on the two new files.
- But the suite has **no test for `AbortManager` at all** (`grep AbortManager test/` matches one comment in `tui.test.js`), no test for `isInterruptKey()`, and no test for interrupt/exit routing.
- The probes are ad-hoc scripts (`probe-abort-keys`, `probe-interrupt`, `probe-cli-keys2`, `probe-esc-widget`), and **none walks cancel-then-exit** as the step requires.

### Missing (the actual bug is still open)

**Step 3 — `createTui`** ❌
- No `options.onInterrupt`, no `isInterruptKey` import, no `exit()` in the returned object.
- The probe shows why this matters: `node probe-esc-widget.mjs` →
  ```
  after escape emit: reading=false focused=false grabKeys=false
  after typing 'a': value=""   reading=false focused=false
  pending promise still unresolved: true
  ```
  ESC makes the textbox emit `cancel` → it blurs and **the pending `question()` promise never settles** (the app hangs, subsequent keystrokes are swallowed). Ctrl+C is not handled by the widget at all.
- Because `main.js` builds the TUI with `captureKeys: !tui`, the AbortManager installs **no** stdin listener in TUI mode and nothing on the screen listens either — so inside the TUI, ESC/Ctrl+C currently reach *nobody*. `probe-interrupt.mjs` confirms only the probe's own listeners saw `["escape","C-c"]`.

**Step 4 — `createCLI`** ❌
- `app/cli.js` is 23 lines: `rl`, `question`, `saveResponse`, `close`. No `exit()`, so an idle Ctrl+C cannot resolve the pending `question()` with `'exit'`.

**Step 5 — `main.js` wiring** ❌
- `new AbortManager(cli.rl, { captureKeys: !tui })` — no `onExit`, no `onInterrupt`, no `confirmMode: tui ? 'keys' : 'prompt'`.
- Consequence: `requestExit()` always returns `false` (`#onExit` is `null`) and the TUI path defaults to `confirmMode: 'prompt'`, which would hijack the shared input box via `rl.question` if it were ever reached.
- The help lines (55-56) still promise behaviour that isn't reachable.

### Also worth flagging

- **`task.md` is out of sync**: item 1 done ✓, item 2 (this plan) is still `[ ]` and is *not* fixed, item 3 (context window size from the API / `"configured (total: real-total)"`) has **no work started** — `grep` shows `CONTEXT_MAX_LENGTH` only read from env in `config/constants.js:77` and `app/context-window.js:22`, with no API-probed total and no configured-vs-real formatting.
- The `'exit'` sentinel the plan relies on is already honoured by the loop (`main.js:61`), so steps 3-5 are the only things standing between the current state and a working ESC/Ctrl+C.

**Suggested next action:** keep the plan at item 2 and implement steps 3 → 4 → 5 (TUI `onInterrupt` + `exit()`, CLI `exit()`, then `main.js` wiring with `confirmMode`), then add real tests for `isInterruptKey`/`AbortManager`/cancel-then-exit before ticking any boxes. Want me to proceed with step 3?