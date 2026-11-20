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
`trackingPaths()` returns the two project-relative paths of the current session, and
`null` paths when **no** session is registered: a checklist belongs to a conversation, so
a session-less process has no store to read or write.

Two sources, consulted in this order and never a third:

1. the **session file** — the copy a human can hot-edit, the escape hatch
   `docs/interface/modes` names;
2. the **session record** — the snapshot inside `<session-id>.json`
   (`docs/runtime/session-store`), used only when the file is gone, so a resumed
   conversation whose folder was cleaned still reads its checklist.

**Writes** always land in the session file and are mirrored into the session record, so
a resumed conversation is self-contained. Without a session a write is refused with
`NO_SESSION` rather than falling back to the tree.

### The project root is not a place the pair lives

There is deliberately **no project-root fallback**, in either direction:

- `readTaskContent()` never reads a root `task.md`, so a file the operator keeps in the
  tree is never mistaken for the conversation's checklist;
- `writeTaskContent()` throws `NO_SESSION` and `ensureTrackingFiles()` is a no-op, so the
  harness can never create one;
- `write_file` refuses a tracking name outside `agent/sessions/<id>/`
  (`utils/tracking-fence.js#trackingLocationRefusal`, code
  `TRACKING_FILE_NOT_IN_SESSION`), which is the one writer that could have created it;
- `design` mode's writable targets are the same shape (`app/mode-policy.js#isDesignWritable`
  reads `isSessionTrackingPath()`), so the mode and the fence cannot disagree.

A root `task.md` was an artefact of the flat layout the per-session move replaced. Where
it still exists in a tree it is the operator's file: leaving it there changes nothing, and
nothing writes it again.

`ensureTrackingFiles()` is called when a session is registered (`main.js`) and again on
resume, and makes the session folder own a canonical pair. A fresh session starts from
the **canonical skeleton** — an empty checklist, no items — and a resumed session is
re-seeded from its own record when its folder went missing. Without that re-seed a session
would report an empty checklist while its record still held one: one reader on the file,
another on the record, and the two disagreeing.

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

- An entry is **one line**, so a long one that a human (or the model) wrapped across
  several lines is folded back into a single entry: an indented continuation line that
  carries no checkbox of its own belongs to the entry above it. Without that fold the
  re-render kept only the first line and the entry came back ending mid-sentence, which
  reads like the harness cut the text rather than re-rendered the document. The same
  fold applies to a note written across several lines.
- The fold is **bounded by contiguity**, which is the whole rule: a continuation belongs
  to the entry above only while it follows it directly. A **blank line**, a **heading** or
  any other line ends the entry. Unbounded, the fold ran to the end of the document and
  the first `## Notes` line was absorbed by the last item — so an item grew a sentence
  nobody wrote into it, and the note it stole was rendered as part of the checklist.
  `parseCheckboxItems()` and `extractNotes()` each carry that guard; `docs/agent/task-tracking`
  states it once and the cases in `tests/tracking-format.test.js` prove it.

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

**Where** the pair lives is not part of what is taught. The prompt and the tool
.description state the rule the model has to follow — the pair belongs to the conversation,
not to the project tree, and `update_task` is the one thing that writes it — while the
absolute location stays the harness's business. The model never has to compute
`agent/sessions/<id>/`: every reply of `update_task` reports the **resolved**
`taskFile`/`planFile` paths, so the path arrives as *data* at the moment it is needed, which
is the only form it is good for (a fresh session's id did not exist when the prompt was
written, and a resumed one may have moved).

The same rule is why the *location* is not left to the first `update_task` call alone. The
prompt cannot teach the path, but the model still needs it before it writes anything, so the
request carries the conversation's identity as a block: its id and the resolved paths of its
`task.md`, its plan and its record, stated once and never recomputed
(`docs/agent/session-context`). The model is told where it lives at the moment its first
turn starts, which is what stops it scanning the tree for a folder it is already in.

## A decision is recorded as it is agreed

The checklist is not a summary written after the work: it is the record of what the
conversation decided. A discussion that reaches an agreement and ends without an item
on `task.md` loses that agreement, because the transcript is then the only place it
ever lived. A decision therefore becomes an item **when it is agreed**: a `design`
session authors the draft with `write_file` at the path `update_task` reported
(normalised into the canonical document, see below), and a `work` session starts the item
with `update_task` (`action: "start"` plus the `steps` just agreed). The prompt states the
rule (`prompt.md`, section 8) because the model is the one that has to follow it.

## Who may author them

The two files are **tool-owned**. `write_file` and `patch_file` name a target, so
`utils/tracking-fence.js` decides what happens when that target is one of them, and the two
tools answer differently because the operations differ in kind:

- **`write_file` re-renders.** Handing it a checklist is a legitimate way to author one —
  a `design` session has no `add` action to grow a list from — so the content is accepted
  and immediately replaced by the canonical document built from it, and the reply carries
  `canonicalised: true`. The model cannot produce a malformed file; it can only produce a
  *draft* that is normalised.
- **`write_file` also checks the place.** The name is accepted only under
  `agent/sessions/<id>/`; a root `task.md` or `implementation_plan.md` is refused with
  `TRACKING_FILE_NOT_IN_SESSION`
  (`utils/tracking-fence.js#trackingLocationRefusal`), because this is the one writer that
  could create the pair outside a conversation.
- **`edit_file` is refused** with `TRACKING_FILE_TOOL_OWNED`, in either shape (a pasted
  diff or a search/replace). A change into a document the harness re-renders is never the
  right move — its hunks would be undone by the next `update_task` call — so the refusal
  names the tool to use instead. `delete_file` answers the same way: the loop keeps both
  files in place for the whole session.

The comparison is on the file **name** for the two editing writers, so the fence covers
the session copies exactly like a stray root file and needs no upkeep when the folder
policy changes. The *location* rule is the stricter, writer-specific half: only
`write_file` can create a file, so only `write_file` asks where it would land.

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
