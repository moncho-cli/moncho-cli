import { applyPatch, PatchError } from '../utils/patch_lib.js';
import { forgetRead, staleWriteRefusal } from '../utils/read-tracker.js';
import { defineTool } from '../utils/tool-schema.js';
import { isToolOwnedFile, trackingFenceRefusal } from '../utils/tracking-fence.js';

/**
 * The two tracking files belong to `update_task` (utils/tracking-fence.js), so a patch
 * that names one is refused with the tool to use instead of being applied.
 *
 * A file the model read and that changed on disk afterwards is refused with
 * `STALE_READ` (`utils/read-tracker.js`) *before* the hunks are matched: a patch built
 * against bytes that are no longer there would either fail on context or, worse, land
 * on lines that merely look right. A successful patch forgets the recorded read,
 * because the bytes on disk are then the model's own.
 */

function errorResponse(error) {
  const code = error.code || (error instanceof SyntaxError ? 'INVALID_ARGUMENTS' : 'UNEXPECTED_ERROR');
  const guidance = {
    NO_HUNKS: 'The patch contained no @@ hunk header. Include at least one "@@ -oldStart,oldLen +newStart,newLen @@" line.',
    INVALID_HUNK_HEADER: 'Use the exact header format "@@ -oldStart,oldLen +newStart,newLen @@".',
    HUNK_COUNT_MISMATCH: 'The @@ counts must exactly match the hunk body: old side = context + deletions, new side = context + additions.',
    INVALID_PATCH_LINE: 'Every hunk body line must start with a space (context), "+" (add) or "-" (del); a blank context line must start with a single space.',
    HUNK_MISMATCH: 'Re-read the file with read_file (lineNumbers:false) and regenerate the patch with exact surrounding context.'
  }[code];
  return JSON.stringify({
    status: 'error',
    code,
    message: error.message,
    ...(guidance ? { guidance } : {}),
    ...(error.details || {})
  });
}

const { definition, execute } = defineTool({
  name: 'patch_file',
  description: "Parses and applies the patch using the 'diff' (jsdiff) library, then verifies the written file byte-for-byte. Apply a standard unified diff to an existing file (or create a new one with --- /dev/null). The result is verified deterministically: the tool only reports success when the file on disk matches the patched content exactly; otherwise it returns a structured error with a stable code and leaves the file unchanged. Parameters: path (relative path of the target file) and patchStr (the full unified diff, including @@ hunks).",
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'Relative path of the target file (must be inside the current directory)'
      },
      patchStr: {
        type: 'string',
        description: "Unified diff patch string with standard '@@ -oldStart,oldLen +newStart,newLen @@' hunks. Every hunk body line MUST start with a prefix: a single space for context, '+' for additions, '-' for deletions (a blank context line is a single space, not an empty line). The counts in each @@ header must exactly match the hunk body: old side = context + deletions, new side = context + additions. Include at least one @@ hunk header, otherwise the tool fails with NO_HUNKS. The +++ header must name the same relative path as 'path'. Read the file with read_file (lineNumbers:false) first, then generate the patch."
      }
    },
    required: ['path', 'patchStr']
  },
  async execute(args) {
    try {
      if (typeof args.path !== 'string' || args.path.trim() === '') {
        throw new PatchError('INVALID_ARGUMENTS', 'patch_file requires a non-empty relative "path" string.');
      }
      if (typeof args.patchStr !== 'string' || args.patchStr.trim() === '') {
        throw new PatchError('INVALID_ARGUMENTS', 'patch_file requires a non-empty "patchStr" unified diff string.');
      }

      // A tracking file is rewritten whole by `update_task`, so a diff into one would
      // be undone by the next tracking call (utils/tracking-fence.js).
      const fenced = trackingFenceRefusal(args.path);
      if (fenced) return JSON.stringify(fenced);

      // A patch is built against the bytes the model read: if those bytes moved, the
      // patch is refused rather than matched against whatever is there now.
      const stale = staleWriteRefusal(args.path, { isToolOwned: isToolOwnedFile });
      if (stale) return JSON.stringify(stale);

      const result = applyPatch(args.patchStr, args.path);
      forgetRead(args.path);
      return JSON.stringify(result);
    } catch (error) {
      return errorResponse(error);
    }
  }
});

export { definition, execute };
