# Agent — project discovery (grep + blob)

Before reading a file the agent usually has to answer two questions: *where* does
this live, and *what do these files contain*. `grep` and `blob` answer both in a
single tool call each, so discovery costs tokens instead of guesses. Both are
**read-only** and share one walker, `utils/project-scan.js`.

## The shared walker

- `listProjectFiles()` is the only way either tool enumerates the tree. It walks
  from a project-relative start path (`"."` = project root) resolved through
  `resolveProjectPath()`, so the file-safety sandbox applies unchanged.
- **Symlinks are never followed** and ignored directories are pruned, so a
  whole-project search cannot leave the tree or disappear into dependencies.
- Default prunes: `DEFAULT_IGNORED_DIRS` (`node_modules`, `.git`, `vendor`,
  `agent`, `dist`, `build`, `coverage`) and `DEFAULT_IGNORED_FILES` (`*.log`,
  `*.tmp`, `*.moncho-write-*.tmp`, `.DS_Store`).
- The start path itself is never ignored, so pointing at `node_modules` explicitly
  still works; `maxFiles` caps the walk and reports `truncated: true`.
- Binary detection is a pure sniff: `looksBinary()` returns true when a NUL byte
  appears in the first 8 KiB. `readTextFile()` combines that with a size ceiling and
  returns `null` for missing, binary or oversized files instead of throwing.

## Globs

- `matchGlob()` implements `*`, `**` and `?` over POSIX-relative paths. A glob that
  contains no `/` matches the **basename**; one that does matches the whole path.
- `normalizeGlobs()` accepts a string (comma-separated globs allowed), an array, or
  nothing, and drops blanks. `matchesAny()` is the OR over a glob list.
- `normalizeGlobGroups()` + the `includeAll` option express **AND** across groups
  (each group is an OR), which is how `blob` intersects a glob `path` with an
  `include` filter.

## grep

- Searches file **contents** and returns `path:line: text` lines wrapped in a
  `<grep pattern="…" path="…" matches=N files=M [truncated=true]>` tag, closed by
  `</grep>`.
- `pattern` is a regular expression; `fixedStrings: true` searches for literal text
  and `ignoreCase: true` folds case. `buildSearchRegExp()` owns that conversion and
  raises `INVALID_PATTERN` for an unparsable expression.
- `include` / `exclude` globs narrow the walk, `filesOnly: true` returns paths
  without the lines, and `maxResults` (default 200) caps the matching lines.
- Lines are previewed to 400 characters and files above 2 MiB or binary are skipped.
- No matches is **not** an error: the tag reports `matches=0` with `(no matches)`.

## blob

- Fetches several files in one call. `path` may be a file, a directory or a glob
  (`resolveBlobTargets()`), and each file is returned as
  `<blob path="…" bytes=N lines=N [truncated=true]> … </blob>` inside a
  `<blobs path="…" count=N bytes=N [truncated=true]>` envelope.
- Binary or oversized files are not a failure: they become
  `<blob path="…" skipped="binary-or-too-large" />`, so one bad file never hides the
  rest of the batch.
- Budgets are explicit: `maxFiles` (default 8), `maxBytesPerFile` (40 KiB) and
  `maxTotalBytes` (120 KiB). A file that only partly fits is truncated and marked
  rather than dropped, and the envelope reports `truncated=true`.

## Failure behaviour

- Both tools return the shared JSON error shape: `status: "error"`, a stable `code`,
  a `message` and a `guidance` line when the caller can fix the call.
- `INVALID_PATH` — the path escapes the project (raised by the sandbox).
- `INVALID_PATTERN` — `grep` was given no pattern, or an unparsable regular
  expression (`guidance` suggests `fixedStrings`).
- `NOT_FOUND` — `blob` matched no file at all.

## See also

- Implementation: `tools/grep.js`, `tools/blob.js`, `utils/project-scan.js`
- Sandbox: `utils/path-safety.js` (docs/agent/file-safety)
- Proof: `tests/discovery-tools.test.js`
