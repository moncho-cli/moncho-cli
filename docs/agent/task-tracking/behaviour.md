# Agent — task tracking (the task.md protocol)

`task.md` is the ordered list of work items of **one conversation**;
`implementation_plan.md` is the plan for **one** item at a time. `update_task` is the
only thing that edits either file, so the bookkeeping is deterministic and the model
only supplies plan text. This spec fixes the protocol, where the files live, the shape
they are written in, and who may touch them; the implementation is linked below.

## Where the two files live

A checklist belongs to the conversation that is working through it, so each session owns
its own pair under its folder:

```
agent/sessions/<session-id>/task.md
agent/sessions/<session-id>/implementation_plan.md
```

The `agent/` tree is gitignored, so a checklist never ships in a commit, and two
conversations over the same repository never fight over one file.
`utils/tracking-store.js` is the single place that decides the paths, and every reader
and writer goes through it — `update_task`, the `work:on` drive and `/work`.
`trackingPaths()` returns the two project-relative paths of the current session, and the
project-root names only when **no** session is registered (a bare tool call, which is
what the tool-level tests drive).

Three sources, consulted in this order and never a fourth:

1. the **session file** — the copy a human can hot-edit, the escape hatch
   `docs/interface/modes` names;
2. the **session record** — the snapshot inside `<session-id>.json`
   (`docs/runtime/session-store`), used only when the file is gone, so a resumed
   conversation whose folder was cleaned still reads its checklist;
3. the **project-root file** — only when no session is registered at all.

**Writes** always land in the session file and are mirrored into the session record, so
a resumed conversation is self-contained. A session never brings a root file back: the
checklist belongs to the session, not to the tree.

`ensureTrackingFiles()` is called when a session is registered (`main.js`) and again on
resume, and makes the session folder own a canonical pair. A fresh session is **seeded**
from the project-root files when they exist, so an operator who already has a `task.md`
in the tree keeps working; a resumed session is re-seeded from its own record when its
folder went missing. Without that seed a session starts with an empty checklist while a
`task.md` sits right there, and the tracking loop refuses every selection because it sees
zero items — one reader on the file, another on the session copy, and the two disagreeing.

## The canonical shape

Both files are authored by one tool, so their shape is not a matter of taste: it is a
**contract** the tool writes and the next call re-reads. One skeleton for both, so a
model never has to guess what a well-formed tracking file looks like:

```
# <title>

status: <pending | in progress: <item> | done>

## Items          (## Steps in the plan)

- [ ] one entry
- [x] a finished entry

## Notes          (optional, human commentary)

- a note
```

- The **title**, the **status line** and the **section heading** must exist, so a file is
  never a bare list of checkboxes that loses what it is about.
- Entries are `- [ ]` / `- [x]` **at column 0**: an indented or `*`-marked entry is a
  different document, not a nested one.
- A **status** is one of the canonical forms (`pending`, `in progress`, `in progress:
  <item>`, `done`), so "where am I" is machine-readable instead of prose.
- `## Notes` is the one place a human remark belongs, and it survives every rewrite.

`renderTaskFile()` / `renderPlanFile()` are the only way the harness writes the files, and
`validateTrackingFile()` reports each broken rule (`ok`, `problems`, `status`, `notes`,
`items`) without throwing. The rules are **reported, not enforced destructively**: a legacy
file — a bare checkbox list — still *reads*; it is reported as non-canonical and upgraded
by `canonicalizeTrackingFile()` the next time it is created or written. The plan's title is
the **item it is the plan for**, because a plan is the plan for one item.

### The model is shown the template, not a description of it

The skeleton above is a contract, so it is also **taught**: `trackingTemplate(kind)` renders
it with placeholders, and that exact text is quoted in the two places the model really reads:

- the **system prompt** (`prompt.md`), next to the tracking protocol, so a model knows what a
  well-formed file looks like before it writes one;
- the **`update_task` description** — the schema the provider is offered — so the shape
  travels with the tool even when the prompt is not in view.

The three copies (renderer, prompt, tool description) cannot drift: the template case in
`tests/tracking-format.test.js` fails when either text stops matching `trackingTemplate()`.
Every reply of `update_task` also reports the **resolved** `taskFile`/`planFile` paths — the
session-folder ones — so the model learns *where* the pair lives, not only its shape.

## Who may author them

The two files are **tool-owned**. `write_file` and `patch_file` name a target, so
`utils/tracking-fence.js` decides what happens when that target is one of them, and the two
tools answer differently because the operations differ in kind:

- **`write_file` re-renders.** Handing it a checklist is a legitimate way to author one —
  a `design` session has no `add` action to grow a list from — so the content is accepted
  and immediately replaced by the canonical document built from it, and the reply carries
  `canonicalised: true`. The model cannot produce a malformed file; it can only produce a
  *draft* that is normalised.
- **`patch_file` is refused** with `TRACKING_FILE_TOOL_OWNED`. A unified diff into a
  document the harness re-renders is never the right move — its hunks would be undone by
  the next `update_task` call — so the refusal names the tool to use instead.

The comparison is on the file **name**, so the fence covers the session copies exactly like
a stray root file, and it needs no upkeep when the folder policy changes.

## The item list and the plan steps

- Items are the checkbox lines of `task.md`: `- [ ] text` or `- [x] text`. The parser
  reports each item's source line, indentation, marker, done flag and trimmed text;
  non-checkbox lines (headings, prose) are ignored, which is what lets a file keep its
  `status:` line and its notes.
- `implementation_plan.md` uses the same checkbox syntax, so the *steps* of the current
  item are parsed by the same rule. Headings, the `status:` line and prose are not steps.
- The plan moves **as soon as a step is verified**, not only when the whole item is
  completed, which is what keeps `implementation_plan.md` a live record instead of a
  stale one. `planProgress` (`total`/`done`/`pending`) summarises it, and its own
  `status:` line records `done` once nothing is pending.

## Selection

- An item is addressed by 1-based `index` **or** by an `item` substring of its text; a
  plan step by `stepIndex` **or** by a `step` substring.
- Selection is strict in both cases: an index outside the list fails, and a substring
  matching zero or more than one entry fails with `ITEM_NOT_FOUND` / `STEP_NOT_FOUND`
  (with the real entries attached). Ambiguity is never resolved by guessing.

## Actions

- `list` — read-only. Reports `progress` (`total`/`done`/`pending`), the item list, the
  next pending item and the current `planProgress`. Nothing is written.
- `start` — reset `implementation_plan.md` for the selected item (or the next pending
  one) with the supplied `steps`/`notes`, and optionally update `status:`.
- `step` — tick exactly one verified step of the current plan, report the new
  `planProgress`, and set the plan's `status:` line to `done` when that was the last one.
  Only `implementation_plan.md` is written, so the reply carries `taskWritten: false`. An
  already-ticked step is skipped with `ALREADY_DONE`; an unmatched one is
  `STEP_NOT_FOUND`; a missing plan is `PLAN_FILE_NOT_FOUND` (never silently created).
- `complete` — mark the selected item `[x]`, set `status:` to `in progress: <next item>`
  (or `done` when nothing is left), report the next pending item and reset the plan for
  it. Completing an already-done item is skipped with `ALREADY_DONE`, not re-applied.
- `status` — only rewrite the `status:` line.

## Invariants

- Exactly one item is changed per `complete`, exactly one step per `step`, and marking a
  line done preserves its indentation and marker.
- Every byte written comes from `utils/tracking-format.js`, so a file on disk is always
  the canonical document — whatever the model or a human left there before.
- The session file and the record snapshot never disagree: every write refreshes both.
- A line that no longer matches the checkbox syntax at its recorded position is a hard
  error rather than a blind edit.
- Both files are written through the verified atomic write path, so the reported
  `taskWritten`/`planWritten` flags are trustworthy.
- The plan always ends up describing the item that is *next*, never the one just
  finished, which is what makes the loop resumable.
- A missing `task.md` is `TASK_FILE_NOT_FOUND`; an unknown action is `INVALID_ACTION`.

## See also

- Implementation: `tools/update_task.js`, `utils/tracking-store.js`,
  `utils/tracking-format.js`, `utils/tracking-fence.js`, `utils/plan-file.js`,
  `utils/file-io.js`, `utils/host.js`, `utils/session-store.js`, `config/constants.js`
- The intent modes that scope these writers: `docs/interface/modes`
- The system prompt that teaches the template: `prompt.md` (section 8)
- Where a session and its folder live: `docs/runtime/session-store`
- Proof: `tests/tracking-store.test.js`, `tests/tracking-format.test.js`,
  `tests/tracking-fence.test.js`, `tests/harness-tools.test.js`,
  `tests/task-plan-progress.test.js`
