status: done

# Frequent plan updates, and bash output you can truncate

Two *easy* items picked from `task-backlog.md`:

> implementation-plan.md should be updated more frequently, as soon as items are done and verified

> the stdout on bash commands, formatted inside a json, cannot be properly truncated as one
> would use pipe + head/tail. so maybe bash responses should be a yaml header and the stdout
> after, and it be possible to pass head/tail parameters to let the model choose that

Both are about the harness reporting its own state honestly: the plan must record a step
**the moment it is verified**, and a command's stdout must be readable and trimmable
without a shell.

## What each item must do

| Item | Behaviour |
| ---- | --------- |
| plan | `update_task` gains a `step` action that ticks exactly one `- [ ]` step of `implementation_plan.md` to `- [x]` as soon as it is verified — the task list and the plan's other lines are left alone. Selection is strict (1-based `stepIndex` or a unique `step` substring), an already-ticked step is `ALREADY_DONE`, an unmatched one is `STEP_NOT_FOUND`, and a missing plan is `PLAN_FILE_NOT_FOUND`. |
| output | a successful `run_bash` answers a **YAML header, a `---` delimiter, then the stdout** (`status`, `command`, `cwd`, `exit_code`, `lines`, `shown`, `truncated`, `mode`), and `head`/`tail` select a line window of the stdout so the model can look at either end without a shell; asking for both is `INVALID_RANGE`. |

## Constraints

- **No new dependency.** The window is array slicing; the header is text.
- **Pure where it matters.** `utils/command-output.js` (the window, the header, the
  document) and `utils/plan-file.js` (the plan rendering, the step parser, the in-place
  tick) are file- and terminal-free, so both are unit tested without a temp project.
- **The task protocol is untouched.** `step` writes only `implementation_plan.md` and
  reports `taskWritten: false`; `complete` still marks the item and moves the plan on to
  the next one.
- **Failures stay structured.** A non-zero exit keeps the JSON diagnostic envelope
  (`COMMAND_FAILED` / `TIMEOUT`) so a stable `code` is machine-readable; only a
  *successful* command answers as a document, and the envelope's stdout honours the same
  window (`stdoutLines`/`stdoutShown`/`stdoutTruncated`/`mode`).
- Every file touched stays **under 300 lines**. `tests/harness-tools.test.js` was heading
  for the 500-line limit, so this pass splits it by capability (harness-tools,
  command-sandbox, command-output-window, context-window, task-plan-progress) rather than
  growing it, and every spec names the suite that now owns its cases
  (`tests/docs-realm.test.js` enforces the links).

## Steps

- [x] **plan steps tick as they are verified** — `utils/plan-file.js` holds
  `parsePlanSteps`/`findPlanStep`/`markPlanStepDone`/`renderPlan`; `tools/update_task.js`
  gains the `step` action (and keeps re-exporting `renderPlan`); `docs/agent/task-tracking`
  and `tests/task-plan-progress.test.js` follow.
- [x] **a YAML header and head/tail for run_bash** — `utils/command-output.js` holds
  `resolveWindow`/`windowLines`/`renderYamlHeader`/`renderCommandOutput`;
  `tools/run_bash.js` answers a success as header + stdout and windows the stdout of a
  failure; `docs/agent/command-sandbox` and `tests/command-output-window.test.js` follow.

## Done when

- both behaviours are in the code, each with a spec under `docs/` naming real
  `path#symbol` references and the exact test cases that prove it;
- `npm test` is green, `tests/docs-realm.test.js` included;
- `node --check` passes on every file touched;
- no file touched exceeds 300 lines (and none grows past 500);
- the two backlog lines are ticked and no scratch file is left behind.
