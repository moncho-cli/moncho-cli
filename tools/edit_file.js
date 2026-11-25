import fs from 'fs';

import { applyEditsToText, EditError, MAX_EDITS } from '../utils/edit_lib.js';
import { applyPatch } from '../utils/patch_lib.js';
import { writeFileVerified } from '../utils/file-io.js';
import { forgetRead, staleWriteRefusal } from '../utils/read-tracker.js';
import { resolveProjectPath, PathSafetyError } from '../utils/path-safety.js';
import { defineTool } from '../utils/tool-schema.js';
import { isToolOwnedFile, trackingEditRefusal } from '../utils/tracking-fence.js';
import { hostExecutableRefusal } from '../utils/host-fence.js';

/**
 * The one editing tool: literal search/replace as the routine path, a pasted unified
 * diff as the rare one.
 *
 * There used to be two tools. `patch_file` was audited across the recorded sessions and
 * every single refusal was `INVALID_PATCH_LINE` (a body line missing its ` `/`+`/`-`
 * prefix) or `HUNK_COUNT_MISMATCH` (the `@@ -N,M` counts disagreeing with the body) —
 * bookkeeping about the diff format, never a disagreement about the file, which was
 * `HUNK_MISMATCH`, about a tenth as common and roughly matched by `SEARCH_NOT_FOUND`.
 * Two tools that can both edit also mean the wrong one is always available, so the tool
 * the model reached for decided the outcome. One tool settles it: a search/replace pair
 * has no counts and no prefixes, so those two classes cannot be expressed at all.
 *
 * `patchStr` survives for the one job a search cannot do — **the user pasted a diff**.
 * Then the model is not authoring the diff, it is forwarding one, so it cannot get the
 * counts wrong either: a malformed pasted diff comes back as a code describing *the
 * input it was handed*, not as feedback on its own generation. The engine is the
 * unchanged `utils/patch_lib.js`.
 *
 * Four rails are shared with the other writers rather than re-implemented:
 *
 *  - **the sandbox** (`resolveProjectPath`): a path outside the project is refused;
 *  - **the staleness guard** (`utils/read-tracker.js`): a file the model read and that
 *    changed on disk since is refused with `STALE_READ`, because the search text it
 *    built would be matched against bytes it never saw;
 *  - **the tracking fence** (`utils/tracking-fence.js`): `task.md` and
 *    `implementation_plan.md` are re-rendered whole by `update_task`, so an edit into
 *    one is refused with the tool to use instead;
 *  - **the verified write** (`writeFileVerified`, and the patch engine's own staged
 *    rename): temp file, read-back, atomic rename.
 *
 * All-or-nothing in both branches: with several edits, nothing is written unless every
 * one matched. The edit that failed is named by index, so a batch never leaves the file
 * half-changed.
 */

/** The JSON guidance shown next to each refusal code. */
const GUIDANCE = {
  EMPTY_SEARCH: 'Pass the exact text to find in "search" — the bytes as they appear in the file.',
  NO_CHANGES: 'Change "replace" so it differs from "search".',
  SEARCH_NOT_FOUND:
    'The refusal carries the file\'s own bytes around the region you meant: build the next call from that source instead of retrying this search text. Read the file only for a region the excerpt does not show.',
  SEARCH_NOT_UNIQUE:
    'Quote more surrounding text so the search is unique, or pass "all": true to replace every occurrence.',
  TOO_MANY_EDITS: 'Split the change into several edit_file calls.',
  INVALID_ARGUMENTS: 'Pass "path" plus either "edits", a "search"/"replace" pair, or (only for a diff the user pasted) "patchStr".',
  INVALID_PATH: 'Use a relative path inside the project directory.',
  STALE_READ: 'Call read_file to see the current bytes, then retry the edit.',
  // The pasted-diff branch answers with the patch engine's own vocabulary.
  NO_HUNKS: 'The pasted diff contained no @@ hunk header. Copy the user\'s diff as they gave it.',
  INVALID_HUNK_HEADER: 'The pasted diff\'s @@ header is malformed; copy it exactly as the user supplied it.',
  HUNK_COUNT_MISMATCH: 'The pasted diff\'s @@ counts disagree with its own body — it is malformed as given; ask for it again.',
  INVALID_PATCH_LINE: 'A line of the pasted diff lost its leading space, "+" or "-" in transit; copy it verbatim.',
  HUNK_MISMATCH: 'The pasted diff does not fit this file. Re-read the file; if it truly does not match, the diff is stale.',
  MULTIPLE_FILES: 'One call carries one file: split the pasted diff into one call per file.',
  PATH_MISMATCH: 'The diff\'s +++ header names a different file than "path"; pass the path the diff itself names.',
};

/**
 * Which shape the call asked for: a pasted diff, or one or more literal edits.
 *
 * The shapes are mutually exclusive and mixing them is refused rather than guessed at —
 * a call that carried both would leave the order undefined.
 */
function shapeOf(args) {
  const hasPatch = typeof args.patchStr === 'string' && args.patchStr.trim() !== '';
  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0;
  const hasPair = typeof args.search === 'string' && args.search !== '';

  if (hasPatch && (hasEdits || hasPair)) {
    throw new EditError(
      'INVALID_ARGUMENTS',
      'Pass either "patchStr" or a "search"/"replace" edit, never both: they are two different operations.',
    );
  }
  if (hasPatch) return { kind: 'patch' };
  if (hasEdits && hasPair) {
    throw new EditError(
      'INVALID_ARGUMENTS',
      'Pass either "edits" or a top-level "search"/"replace" pair, not both.',
    );
  }
  if (hasEdits) return { kind: 'edits', edits: args.edits };
  if (hasPair) return { kind: 'edits', edits: [{ search: args.search, replace: args.replace, all: args.all }] };
  throw new EditError(
    'INVALID_ARGUMENTS',
    'edit_file needs the text to find: pass "edits": [{ "search", "replace" }] or a top-level "search"/"replace".',
  );
}

/** The error response for anything thrown below, in the shared structured shape. */
function errorResponse(error, path) {
  const known = error instanceof EditError
    || error instanceof PathSafetyError
    || error?.name === 'PatchError';
  const code = known ? error.code : (error.code || 'UNEXPECTED_ERROR');
  return JSON.stringify({
    status: 'error',
    code,
    message: error.message,
    ...(GUIDANCE[code] ? { guidance: GUIDANCE[code] } : {}),
    ...(error.details || {}),
    ...(path === undefined ? {} : { path }),
  });
}

const { definition, execute } = defineTool({
  name: 'edit_file',
  description: 'Change part of a file by replacing literal text: the routine way to edit. Pass "search" (the text to find, copied verbatim with its indentation) and "replace" (what to put there). The search is literal, never a regular expression; it must match exactly once, or pass "all": true to replace every occurrence. Several edits can be sent at once as "edits": [{ "search", "replace" }] and are applied in order, all-or-nothing: nothing is written unless every edit matched. A search that does not match is refused with SEARCH_NOT_FOUND plus the nearest lines and, when it can tell, why they differ; one whose bytes differ only in line-edge whitespace or line endings is repaired once and applied, and the success reports "repaired" so you know the file\'s own bytes were used. one that matches several times is refused with SEARCH_NOT_UNIQUE plus every line. Never write a diff yourself — compose the edit as search/replace. "patchStr" takes a unified diff verbatim and exists for one case only: the USER pasted a diff and asked for it to be applied. The file is written atomically and verified byte-for-byte before success is reported.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the file to edit (must be inside the current directory)',
      },
      search: {
        type: 'string',
        description: 'The exact text to find, copied verbatim from the file including its indentation. Literal, not a regular expression. Must match exactly once unless "all" is true.',
      },
      replace: {
        type: 'string',
        description: 'The text to put in place of "search". It must differ from "search" (NO_CHANGES otherwise); use "" to delete it.',
      },
      all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of refusing when the search matches more than once. Default false.',
      },
      edits: {
        type: 'array',
        description: `Several edits applied in order, all-or-nothing (at most ${MAX_EDITS}). Each item is { "search", "replace", "all"? }: search must be non-empty and differ from replace. The final result must change the file. An alternative to a top-level "search"/"replace" pair, never both.`,
        items: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            replace: { type: 'string' },
            all: { type: 'boolean' },
          },
          required: ['search', 'replace'],
        },
      },
      patchStr: {
        type: 'string',
        description: 'A unified diff to apply verbatim. Use this ONLY when the user pasted a diff and asked for it to be applied — never as a way to write a diff yourself. Standard "@@ -oldStart,oldLen +newStart,newLen @@" hunks; every body line keeps its leading space, "+" or "-"; the +++ header must name the same file as "path". Its counts and prefixes are the user\'s, and a malformed diff is reported back rather than guessed at.',
      },
    },
    required: ['path'],
  },
  async execute(args) {
    const path = args?.path;
    try {
      if (typeof path !== 'string' || path.trim() === '') {
        throw new EditError('INVALID_ARGUMENTS', 'edit_file requires a non-empty relative "path" string.');
      }

      // A tracking file is rewritten whole by `update_task`, so a region edit into one
      // would be undone by the next tracking call.
      const fenced = trackingEditRefusal(path);
      if (fenced) return JSON.stringify(fenced);

      // A path the host executes — a git hook, the repo config, the env file the runner
      // sources — is refused before the search text is even matched: an edit into one is
      // host code execution, and the sandbox's "inside the project" answer is not the
      // question for these (`utils/host-fence.js`).
      const hostExec = hostExecutableRefusal(path);
      if (hostExec) return JSON.stringify(hostExec);

      // The search text — or the diff — was built from the bytes the model read: if those
      // bytes moved, matching against whatever is there now could land on the wrong region.
      const stale = staleWriteRefusal(path, { isToolOwned: isToolOwnedFile });
      if (stale) return JSON.stringify(stale);

      const shape = shapeOf(args);

      // The pasted-diff branch: the engine resolves its own path, applies the diff through
      // `diff` (jsdiff), re-verifies it and stages the rename (utils/patch_lib.js).
      if (shape.kind === 'patch') {
        const applied = applyPatch(args.patchStr, path);
        forgetRead(path);
        return JSON.stringify({ ...applied, mode: 'patch' });
      }

      let absPath;
      try {
        absPath = resolveProjectPath(path);
      } catch (error) {
        if (error instanceof PathSafetyError) throw error;
        throw error;
      }
      if (!fs.existsSync(absPath)) {
        throw new EditError('FILE_NOT_FOUND', `There is no file at ${path} to edit.`, {
          path,
          guidance: 'Use write_file to create a file that does not exist yet.',
        });
      }

      const original = fs.readFileSync(absPath, 'utf-8');
      const applied = applyEditsToText(original, shape.edits);

      if (applied.content === original) {
        throw new EditError('NO_CHANGES', `The edits matched in ${path} but produced identical bytes.`);
      }

      const written = writeFileVerified(path, applied.content);
      // The bytes on disk are now the model's own: no stale view is left to guard.
      forgetRead(path);

      const replacements = applied.report.reduce((sum, entry) => sum + entry.replacements, 0);
      // The repairs the engine had to make, so a success that needed one says so instead of
      // reading as if the search had matched the bytes the model wrote.
      const repairs = applied.report.filter((entry) => entry.repaired);
      const repairedNote = repairs.length
        ? ` Repaired ${repairs.length} search(es) that differed only in formatting: ${repairs.map((entry) => entry.repaired.note).join('; ')}.`
        : '';
      return JSON.stringify({
        status: 'success',
        path,
        editsApplied: applied.report.length,
        replacements,
        bytes: written.bytes,
        ...(applied.crlf ? { crlf: true } : {}),
        ...(repairs.length ? { repaired: repairs.map((entry) => ({ editIndex: entry.editIndex, ...entry.repaired })) } : {}),
        verification: { readbackMatches: true, bytes: written.bytes },
        edits: applied.report,
        message: `Successfully applied ${applied.report.length} edit(s) making ${replacements} replacement(s) in ${path}.${repairedNote}`,
      });
    } catch (error) {
      return errorResponse(error, path);
    }
  },
});

export { definition, execute };