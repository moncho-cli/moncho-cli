# Frequent plan updates, and bash output you can truncate — both items done and verified

status: done — `npm test` 307 tests, 307 pass, 0 fail

## Items

- [x] **plan steps tick as they are verified** — `utils/plan-file.js` (pure: the checkbox
  parsing, the strict selection, the in-place tick, `planProgress`, the plan rendering)
  and the new `step` action of `tools/update_task.js` (`step`/`stepIndex`); the task list is
  never rewritten (`taskWritten: false`), the plan's own `status:` becomes
  `done — every step verified` on the last tick, and refusals are `STEP_NOT_FOUND` /
  `ALREADY_DONE` / `PLAN_FILE_NOT_FOUND`. Proven by `tests/task-plan-progress.test.js`
  (13 cases) plus the five existing task cases.
- [x] **a YAML header and head/tail for run_bash** — `utils/command-output.js` (pure:
  `resolveWindow`, `windowLines`, `yamlScalar`, `renderYamlHeader`, `renderCommandOutput`)
  and `tools/run_bash.js` now answer a **success** as a YAML header + `---` + stdout, window
  that stdout with `head`/`tail`, refuse both at once with `INVALID_RANGE`, and keep the
  structured `COMMAND_FAILED`/`TIMEOUT` envelope with a windowed stdout for a failure.
  Proven by `tests/command-output-window.test.js` (14 cases) and the sandbox cases in
  `tests/command-sandbox.test.js`.

## Steps

- [x] Write `utils/plan-file.js`: `parseCheckboxItems`/`parsePlanSteps`, `findCheckboxItem`/
  `findPlanStep`, `markCheckboxItem`/`markPlanStepDone`, `readStatusLine`/`replaceStatusLine`,
  `planProgress`, `renderPlan` — no `fs`, no terminal.
- [x] Rework `tools/update_task.js` on top of it, add the `step` action and report
  `planProgress` on `list`, keeping `renderPlan` re-exported.
- [x] Write `utils/command-output.js` and rework `tools/run_bash.js` to answer a document,
  with `head`/`tail` in the tool schema and a windowed failure envelope.
- [x] Extend `docs/agent/task-tracking` and `docs/agent/command-sandbox` (behaviour.md +
  spec.yaml) and register the new suites in `tests/README.md`.
- [x] Add the three new suites and re-point every case a spec names; split the 500-line
  `tests/harness-tools.test.js` by capability (harness-tools, command-sandbox,
  command-output-window, context-window, task-plan-progress).
- [x] Run `node --check` on every touched file and `npm test`; tick both backlog lines,
  update `README.md`/`prompt.md`, leave no scratch file behind.

## Verified

- `npm test` → **307 tests, 307 pass, 0 fail**, `tests/docs-realm.test.js` included.
- `node --check` clean on every touched file (`tools/run_bash.js`, `tools/update_task.js`,
  `utils/command-output.js`, `utils/plan-file.js`, the suites).
- End-to-end smoke: `run_bash({ command: 'ls app', head: 3 })` answers
  `status: success … lines: 30 shown: 3 truncated: true mode: head`, then `---`, then the
  three lines.
- Every file touched is **under 300 lines**; the largest is `tests/command-output-window.test.js`
  at 255 (the 500-line suite is gone; nothing grows past 300).
- No scratch probe was written, so none is left behind: `git status` lists only the two
  new modules and the new suites.
