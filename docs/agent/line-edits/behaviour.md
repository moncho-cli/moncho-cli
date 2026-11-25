# Agent — diff-free line edits

`edit_file` is the agent's **routine** editing tool. It replaces literal text: you give it
the exact bytes to find and the bytes to put there, and it writes nothing until the search
has matched. It exists because the *diff format* was the failure, not the edit — see
"why this exists" below.

It also takes `patchStr` — a unified diff applied verbatim, through the unchanged
`utils/patch_lib.js` engine. That branch exists for exactly one case: **the user pasted a
diff.** Then the model is forwarding a diff rather than authoring one, so the counts are
the user's and cannot be got wrong; a malformed diff is reported back as a fact about the
input. Never reach for it to express your own change.

## Input

- `path` (required) plus **one** of: `search`/`replace` (with `all`), an `edits`
  array, or `patchStr`. Mixing them is `INVALID_ARGUMENTS`.
- Or `edits: [{ search, replace, all? }]` — several edits, applied **in order**.
  Passing both shapes at once is `INVALID_ARGUMENTS`, never a guess.
- `search` is matched **literally**, by `indexOf`, never as a regular expression:
  `a.b` matches `a.b` and not `aXb`. A model-supplied search is source code, and source
  code is full of `*`, `(`, `[` and `$`.
- An empty `search` is `EMPTY_SEARCH`; a `search` equal to its `replace` is `NO_CHANGES`
  (the edit would do nothing); a missing file is `FILE_NOT_FOUND`.
- At most 50 edits per call (`TOO_MANY_EDITS`), because a larger batch is a rewrite and
  `write_file` says so in one place. The model-facing parameter descriptions state the
  non-empty, different-replacement and changed-final-result criteria before a call.

## Guarantees

- **All-or-nothing.** With several edits, nothing is written unless every one matched.
  A batch that fails on its third edit leaves the file byte-identical, and the refusal
  names which edit failed (`editIndex`, `editsInBatch`).
- **Ordered.** Each edit matches against the result of the previous one, so a later edit
  sees the earlier replacement.
- **Verified.** The write goes through the shared atomic path (temp file, read-back,
  rename), so success is only reported when the bytes on disk are the intended ones.
- **Line endings are the file's.** A CRLF file whose search carries LF is matched as if it
  were LF, and the CRLF is restored, so a model that types `\n` can still edit a Windows
  file. A search that *does* carry `\r\n` is matched byte-for-byte.
- **The shared rails hold.** The path sandbox refuses anything outside the project
  (`INVALID_PATH`); a file the model read that changed on disk since is refused with
  `STALE_READ`; `task.md` and `implementation_plan.md` are refused with
  `TRACKING_FILE_TOOL_OWNED` and the tool to use instead.

## Failure codes

| Code | Meaning |
| ---------------------- | -------------------------------------------------------------- |
| `SEARCH_NOT_FOUND` | The search text is not in the file. Carries `candidates`, `source` (the file's own numbered bytes around the region) and, when it can tell, a `hint`. |
| `SEARCH_NOT_UNIQUE` | The search matched more than once and `all` was not set. Carries every `occurrences[].line`. |
| `EMPTY_SEARCH` | `search` is missing or empty. |
| `NO_CHANGES` | `search` equals `replace`, or the edits produced identical bytes. |
| `INVALID_ARGUMENTS` | Neither shape supplied, both supplied, or a missing `path`. |
| `TOO_MANY_EDITS` | More than 50 edits in one call. |
| `FILE_NOT_FOUND` | There is no file at `path`. |
| `INVALID_PATH` | The path escapes the project directory. |
| `STALE_READ` | The file changed after the model read it. |
| `TRACKING_FILE_TOOL_OWNED` | A tracking file: `update_task` owns it. |

### A refusal is meant to be fixable in one retry

A refusal that only says "not found" costs a re-read and another model call. Before that
point is reached, a search whose bytes differ only in **line-edge whitespace or line
endings** is repaired once and applied (`docs/agent/edit-repair`): the repair normalises only
the line edges, refuses to choose when the block matches in several places, and never
re-indents the replacement. What follows is the refusal, for the misses no repair can settle.

A refusal that only says "not found" costs a re-read and another model call. So
`SEARCH_NOT_FOUND` answers with **evidence**:

- `candidates` — the lines that most resemble the search, best first, with their numbers.
  The list is never empty when the file has any non-blank line: when nothing clears the
  relevance floor the strongest lines are returned anyway, because an empty array tells
  the caller nothing.
- `hint` — *why* the text did not match, when the best candidate is the same text with
  different bytes: indentation (`line N holds the same text but with 4 leading space(s),
  not 2`), trailing whitespace, or a line-ending difference. This is the diagnosis
  `HUNK_MISMATCH` never gave.
- **`source`** — the file's own numbered lines around the region
  (`utils/edit-miss.js#sourceExcerpt`), bounded to `SOURCE_WINDOW` lines and anchored on the
  best candidate (or the head of the file when nothing resembles the search). Candidates say
  *which* line was meant; the source says what that line and its neighbours really hold,
  which is what the next attempt has to be built from.
- `retry: do not retry this search text unchanged` — the refusal is only worth carrying the
  bytes if the caller stops guessing, because a retry of the same search spends a call to be
  told what the answer already said (backlog item 65).

The excerpt makes `read_file` a **fallback rather than a step**: the guidance names it for
the one case it is still needed — a region this excerpt does not show — so the round trip is
spent only when the evidence is genuinely outside the window.

`SEARCH_NOT_UNIQUE` answers with every matching line, so the caller can quote more
context or set `all: true` deliberately.

## The precondition, stated to the model

A search is matched against the file's bytes, so it can only be composed from the file's
bytes. That is a fact about the engine, and it is stated to the model as a rule
(`config/prompt.md` §3.4): **an edit is legal only against bytes just read**, and the region
about to change is read with `read_file` before the edit is composed.

The rule names the paraphrases explicitly, because each of them *looks* like the bytes and
is not one: a `hint_file` sketch (tabs expanded, blank runs collapsed, long lines cut), a
`blob` page, a `grep` line, a remembered line number, another file's copy of the same text,
and the model's own earlier `replace`. It also names the two refusals the mistake produces —
`SEARCH_NOT_FOUND`, which carries the diagnosis to fix it, and `NO_CHANGES` on a search equal
to its replacement, which is the signature of a search copied from somewhere other than the
file — and `write_file`, which is the way out when the region is large or the file is being
rewritten whole.

The rule is prose in the shipped system prompt rather than code in this repository
(`config/prompt.md` is not a document of the project, §6), so the contract is held by a test
instead: `tests/edit-prompt-contract.test.js` reads the section and fails if it stops naming
the tools the model can reach or the refusals it can receive.

## Why this exists

Measured across the recorded sessions, every `patch_file` failure was
`INVALID_PATCH_LINE` (a hunk body line with a missing or wrong prefix) or
`HUNK_COUNT_MISMATCH` (the `@@ -N,M` counts disagreeing with the body). Both are
bookkeeping about the diff format, not a disagreement about the file. The genuine context
mismatch (`HUNK_MISMATCH`) was roughly a tenth as common. A search/replace pair has no
counts to get wrong and no per-line prefixes, so it removes the two dominant classes;
what remains is `SEARCH_NOT_FOUND`, which is `HUNK_MISMATCH` with evidence attached.

Nothing was ever written incorrectly under the old tool — every failure fired before the
rename — so this is a change of *drivability*, not of safety.

## See also

- Implementation: `utils/edit_lib.js`, `tools/edit_file.js`
- The diff-shaped fallback: `docs/agent/patch-application`
- Proof: `tests/edit.test.js`, `tests/edit-prompt-contract.test.js`
