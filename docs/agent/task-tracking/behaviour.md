# Agent — task tracking (task.md protocol)

`task.md` carries the ordered list of work items; `implementation_plan.md` carries
the plan for **one** item at a time. `update_task` is the only thing that edits
either file, so the bookkeeping is deterministic and the model only supplies
plan text. This spec fixes the protocol; the implementation is linked below.

## The item list

- Items are the checkbox lines of `task.md`: `- [ ] text` or `- [x] text` (also
  `*` markers, any indentation, upper- or lower-case `x`).
- The parser reports each item's source line, indentation, marker, done flag and
  trimmed text. Non-checkbox lines (headings, prose) are ignored, which is what
  lets `task.md` keep a `status:` line and explanatory text.
- The optional `status:` line is read separately; it is the human progress marker,
  distinct from the per-item checkboxes.

## The plan steps

- `implementation_plan.md` uses the same checkbox syntax, so the *steps* of the
  current item are parsed by the same rule as the items of `task.md`. Headings,
  the `status:` line and prose are not steps.
- The plan moves **as soon as a step is verified**, not only when the whole item is
  completed: a step is ticked in place the moment it is proven, which is what keeps
  `implementation_plan.md` a live record instead of a stale one.
- Ticking is in place: exactly one line changes, indentation and marker are
  preserved, and the other bytes of the file are untouched. A line that no longer
  matches the checkbox syntax at its recorded position is a hard error rather than a
  blind edit.
- `planProgress` (`total`/`done`/`pending`) summarises the plan, and the plan's own
  `status:` line records `done — every step verified` once nothing is pending.

## Selection

- An item is addressed by 1-based `index` **or** by an `item` substring of its
  text; a plan step by `stepIndex` **or** by a `step` substring.
- Selection is strict in both cases: an index outside the list fails, and a
  substring matching zero or more than one entry fails with `ITEM_NOT_FOUND` /
  `STEP_NOT_FOUND` (with the real entries attached). Ambiguity is never resolved by
  guessing.

## Actions

- `list` — read-only. Reports `progress` (`total`/`done`/`pending`), the item list,
  the next pending item and the current `planProgress`. Nothing is written.
- `start` — reset `implementation_plan.md` for the selected item (or the next
  pending one) with the supplied `steps`/`notes`, and optionally update `status:`.
- `step` — tick exactly one verified step of the current plan (in place), report the
  new `planProgress` and set the plan's `status:` line to `done — every step verified`
  when that was the last one. Only `implementation_plan.md` is written, so the reply
  carries `taskWritten: false`. An already-ticked step is skipped with
  `ALREADY_DONE`; an unmatched one is `STEP_NOT_FOUND`; a missing plan is
  `PLAN_FILE_NOT_FOUND` (never silently created).
- `complete` — mark the selected item `[x]`, set `status:` to
  `in progress: <next item>` (or `done` when nothing is left), report the next
  pending item and reset the plan for it. Completing an already-done item is
  skipped with `ALREADY_DONE`, not re-applied.
- `status` — only rewrite the `status:` line.

## Invariants

- Exactly one item is changed per `complete`, exactly one step per `step`, and
  marking a line done preserves its indentation and marker.
- A line that no longer matches the checkbox syntax at its recorded position is a
  hard error rather than a blind edit.
- Both files are written through the verified atomic write path, so the reported
  `taskWritten`/`planWritten` flags are trustworthy.
- The plan always ends up describing the item that is *next*, never the one just
  finished, which is what makes the loop resumable.
- A missing `task.md` is `TASK_FILE_NOT_FOUND`; an unknown action is
  `INVALID_ACTION`.

## See also

- Implementation: `tools/update_task.js`, `utils/plan-file.js`, `utils/file-io.js`,
  `config/constants.js`
- Proof: `tests/harness-tools.test.js`, `tests/task-plan-progress.test.js`
