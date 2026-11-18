# Agent — file safety (path sandbox + verified writes)

The agent may only ever touch files **inside the project tree**, and a tool may only
report success when the bytes on disk really are the requested bytes. This spec
covers both guarantees. Implementations are linked at the bottom.

## The path sandbox

- Every file operation resolves its path through `resolveProjectPath()` in
  `utils/path-safety.js`.
- **Rejected outright** with `PathSafetyError` code `INVALID_PATH`:
  - an empty/blank/non-string path,
  - an absolute path,
  - a path that resolves outside the project root (`..` traversal), including a
    path that resolves exactly *to* the root.
- **Symlinks are walked segment by segment.** Each existing segment that is a
  symlink is resolved and re-checked against the real project root, so a symlink
  cannot smuggle a write outside the tree.
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
- `content` must be a string; anything else is `INVALID_CONTENT`.
- `readFileIfExists()` returns `null` for a missing file rather than throwing,
  which callers use for optional reads (e.g. the task/plan bookkeeping).

## How tools surface it

- `write_file` returns JSON: success carries `status: "success"`, `bytes`,
  `created` and `verified: true`; failure carries `status: "error"`, the sandbox
  `code` and a `guidance` line telling the caller how to fix the path.
- `read_file` wraps its result in the `<file relative_path="…">` delimiter and
  never silently returns an empty body for a page that is fully out of range — the
  tag still reports the path.

## See also

- Implementation: `utils/path-safety.js`, `utils/file-io.js`, `tools/read_file.js`,
  `tools/write_file.js`
- Proof: `tests/harness-tools.test.js`
