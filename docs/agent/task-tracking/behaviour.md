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

## Selection

- An item is addressed by 1-based `index` **or** by an `item` substring of its
  text.
- Selection is strict: an index outside the list fails, and a substring matching
  zero or more than one item fails with `ITEM_NOT_FOUND` (with the item list
  attached). Ambiguity is never resolved by guessing.

## Actions

- `list` — read-only. Reports `progress` (`total`/`done`/`pending`), the item
  list and the next pending item. Nothing is written.
- `start` — reset `implementation_plan.md` for the selected item (or the next
  pending one) with the supplied `steps`/`notes`, and optionally update `status:`.
- `complete` — mark the selected item `[x]`, set `status:` to
  `in progress: <next item>` (or `done` when nothing is left), report the next
  pending item and reset the plan for it. Completing an already-done item is
  skipped with `ALREADY_DONE`, not re-applied.
- `status` — only rewrite the `status:` line.

## Invariants

- Exactly one item is changed per `complete`, and marking a line done preserves its
  indentation and marker.
- A line that no longer matches the checkbox syntax at its recorded position is a
  hard error rather than a blind edit.
- Both files are written through the verified atomic write path, so the reported
  `taskWritten`/`planWritten` flags are trustworthy.
- The plan always ends up describing the item that is *next*, never the one just
  finished, which is what makes the loop resumable.
- A missing `task.md` is `TASK_FILE_NOT_FOUND`; an unknown action is
  `INVALID_ACTION`.

## See also

- Implementation: `tools/update_task.js`, `utils/file-io.js`, `config/constants.js`
- Proof: `tests/harness-tools.test.js`
