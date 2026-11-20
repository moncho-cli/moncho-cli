# Agent — patch application

This is the **engine** behind `edit_file`'s `patchStr` argument, not a tool of its own:
`docs/agent/line-edits` owns the interface, and a diff reaches the system only when the
user pasted one. The engine itself is unchanged from when it had a tool of its own, which
is why this spec still describes the format in full.

The routine path moved for a measured reason: across the recorded sessions nearly every
refusal here was `INVALID_PATCH_LINE` or `HUNK_COUNT_MISMATCH` — diff bookkeeping, not a
disagreement about the file. The guarantees below are unchanged; this spec still fixes
the accepted input format, the guarantees, and the exact failure codes so a caller can
always tell *why* a patch was refused. Nothing is ever written on a refusal.

## Input

- A single unified diff against **one** project-relative file. `path` and
  `patchStr` must both be non-empty strings; otherwise `INVALID_ARGUMENTS`.
- The patch must start with `--- a/<path>` / `+++ b/<path>` (or `--- /dev/null` to
  create a file). The `+++` path must name the same file as the `path` argument.
- At least one `@@ -oldStart,oldLen +newStart,newLen @@` hunk header is required.
- Every hunk body line must be prefixed: ` ` context, `+` addition, `-` deletion.
  A blank context line must carry its leading space (an unprefixed blank line is
  tolerated as a compatibility fallback).
- The counts in each header must match that hunk's body exactly: old side =
  context + deletions, new side = context + additions.
- Hunks are applied in file order. CRLF line endings and the `\ No newline at end
  of file` marker are preserved.

## Guarantees

- **All-or-nothing.** A failing hunk prevents every other hunk from being written;
  a refused patch leaves the target byte-identical.
- **Independent verification.** The patch is applied through the `diff` (jsdiff)
  library and the result is re-verified, so the tool only reports success when the
  file on disk matches the patched content exactly.
- **Bounded fuzz.** A hunk whose header line numbers have drifted is still applied
  when the surrounding context matches within the fuzz window; context that does
  not match is a hard failure, never a silent guess.

## Failure codes

| Code | Meaning |
| ---------------------- | -------------------------------------------------------------- |
| `NO_HUNKS` | No `@@` header in the patch. |
| `INVALID_HUNK_HEADER` | The `@@` header is not in the exact expected format. |
| `HUNK_COUNT_MISMATCH` | The header counts disagree with the hunk body. |
| `INVALID_PATCH_LINE` | A hunk body line has no / an invalid prefix. |
| `HUNK_MISMATCH` | The context does not match the file. |
| `MULTIPLE_FILES` | The patch touches more than one file. |
| `INVALID_PATCH` | Structural problem (e.g. a missing `+++` header). |
| `INVALID_ARGUMENTS` | `path`/`patchStr` missing or not a string. |

Each error response is JSON with `status: "error"`, the `code`, a human `message`,
and a `guidance` hint for the fixable codes. `HUNK_MISMATCH` additionally reports
the first mismatching line.

## See also

- The routine editor: `docs/agent/line-edits`
- Implementation: `utils/patch_lib.js`, `tools/patch_file.js`
- Proof: `tests/patch.test.js`, `tests/harness-tools.test.js`
