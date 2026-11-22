# Agent — file safety (path sandbox, verified writes and a verified delete)

The agent may only ever touch files **inside the project tree**, and a tool may only
report success when the bytes on disk really are the requested bytes. This spec covers
both guarantees, for the three operations the harness performs: read, write and delete.
Implementations are linked at the bottom.

## The path sandbox

- Every file operation resolves its path through `resolveProjectPath()` in
  `utils/path-safety.js`. There is no second way in: `read_file`, `write_file`,
  `patch_file` and `delete_file` all inherit the same check.
- **Rejected outright** with `PathSafetyError` code `INVALID_PATH`:
  - an empty/blank/non-string path,
  - an absolute path,
  - a path that resolves outside the project root (`..` traversal), including a
    path that resolves exactly *to* the root.
- **Symlinks are walked segment by segment.** Each existing segment that is a
  symlink is resolved and re-checked against the real project root, so a symlink
  cannot smuggle an operation outside the tree.
- `projectRelativePath()` returns the same path in POSIX form relative to the
  project root, which is what read results and error messages report — tool output
  is therefore stable regardless of the host OS separator.

## Verified writes

- `writeFileVerified()` in `utils/file-io.js` is the only write path used by
  `write_file`.
- The write is **atomic and verified**:
  1. a sibling temp file is written and read back; a mismatch raises
     `VERIFICATION_FAILED` and nothing is changed;
  2. the temp file is renamed over the target (an existing file keeps its mode);
  3. the target is read back once more; a mismatch raises
     `POST_WRITE_VERIFICATION_FAILED`.
- The temp file is removed in a `finally` block, so a failed write leaves no
  debris.
- Creating a file creates its parent directories; overwriting a file follows the
  real path so a symlinked target is not replaced by a plain file.
- `content` must be a string; anything else is `INVALID_CONTENT`. The model-facing
  path description also states the sandbox, stale-read exception for tracking files,
  and host-executable path refusal before a call.
- `readFileIfExists()` returns `null` for a missing file rather than throwing,
  which callers use for optional reads (e.g. the task/plan bookkeeping).

## The stale-read guard

The sandbox stops the agent from reaching outside the project; the **stale-read guard**
stops it from overwriting a change it never saw. A read is not just a look — the model
now believes it knows what is in the file — so the bytes it was handed are remembered,
and a write built on those bytes is refused once they have moved. This is
`utils/read-tracker.js`.

- A **read is recorded as a fingerprint** of what was handed over: the file's
  modification time and size, keyed by its project-relative path. `read_file` and
  `hint_file` record it as they read; `blob` records every file it wraps.
- Before a write or a patch the file is fingerprinted again. The **same pair** means the
  model's view is still the file on disk and the write goes ahead. A **different pair**
  means someone else touched it — the user in an editor, another tool, a previous turn —
  and the operation is refused with `STALE_READ` and a `guidance` line naming the
  `read_file` call that clears it. A refusal changes nothing.
- `patch_file` refuses **before** it matches a hunk: a diff built against bytes that are
  gone would either fail on context or, worse, land on lines that merely look right.
- A **successful write or patch forgets the record**, because the bytes on disk are then
  exactly what the model just supplied; `delete_file` forgets the path it removed.
- **Only a file the model really read is guarded.** A file it never read, and a file that
  does not exist yet, are written as before — there is no stale view to protect, and
  inventing one would refuse every legitimate create. A file *removed* after the read is
  not refused either: there is no unseen content to clobber, and sending the model to
  re-read a path that is gone would be a dead end.
- The **tracking files are exempt**. `task.md` and `implementation_plan.md` are rewritten
  whole by `update_task`, so a read of one is routinely followed by a harness write; the
  fence already answers for them (`docs/agent/task-tracking`).
- The record is **host state, never a chunk**: it lives in the module's own map, so it
  costs no context and is not persisted. A resumed session therefore starts with nothing
  recorded and guards nothing, which is the safe direction — a refusal needs a recorded
  read to exist.

## Verified delete

A write can be corrected by writing again; a **delete cannot be undone by retrying the
call**, so the removal is the strictest of the three operations. `deleteFileVerified()`
in `utils/file-io.js` is the only delete path, and `tools/delete_file.js` is a thin
wrapper over it.

- The path is resolved through the same sandbox first, so a delete can never leave the
  project tree — "only within the workdir" is not a check the tool performs, it is the
  property it inherits.
- The entry is inspected with **`lstatSync`**, so a symlink is seen as a link rather
  than as its target:
  - a **directory** is `IS_DIRECTORY` — this removes one file, never a tree;
  - a fifo/socket/device is `NOT_A_FILE`;
  - a **symlink is deleted** (the link is unlinked, its target untouched).
- A path that does not exist is `NOT_FOUND`, never a silent success: the removal is
  idempotent on disk but its *report* is not, because the caller has to know whether it
  deleted something it meant to delete.
- Success is only claimed after the path is really gone; a file still there raises
  `POST_DELETE_VERIFICATION_FAILED`.
- A blank or missing `path` is `INVALID_ARGUMENTS`, a **different code** from
  `INVALID_PATH`: the caller's fix is a different one (send a path, not move it).
- `task.md` and `implementation_plan.md` are **never deleted**, in any folder. They are
  rewritten whole by `update_task`, so `trackingDeleteRefusal()`
  (`utils/tracking-fence.js`) answers `TRACKING_FILE_TOOL_OWNED` and names that tool —
  the same fence, and the same code, that refuses a patch into one of them
  (`docs/agent/task-tracking`).

## How tools surface it

- `write_file` returns JSON: success carries `status: "success"`, `bytes`,
  `created` and `verified: true`; failure carries `status: "error"`, the sandbox
  `code` and a `guidance` line telling the caller how to fix the path.
- `delete_file` returns JSON in the same shape: success carries `status: "success"`,
  `bytes`, `deleted: true` and `verified: true`; failure carries the `code` above plus
  the `guidance` line for it.
- `read_file` wraps its result in the `<file relative_path="…">` delimiter and
  never silently returns an empty body for a page that is fully out of range — the
  tag still reports the path.
- A refusal from the stale-read guard carries `status: "error"`, `code: "STALE_READ"`,
  the path, the reason (`modified`), the recorded and current byte counts, and the
  `guidance` naming the re-read — the same shape as every other tool refusal.

## See also

- Implementation: `utils/path-safety.js`, `utils/file-io.js`, `utils/read-tracker.js`,
  `tools/read_file.js`, `tools/write_file.js`, `tools/delete_file.js`,
  `utils/tracking-fence.js`
- The fence that owns the two tracking files: `docs/agent/task-tracking`
- Proof: `tests/harness-tools.test.js`, `tests/delete-file.test.js`,
  `tests/stale-read.test.js`
