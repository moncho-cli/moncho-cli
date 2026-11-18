import { applyPatch, PatchError } from '../utils/patch_lib.js';
import { defineTool } from '../utils/tool-schema.js';

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

      return JSON.stringify(applyPatch(args.patchStr, args.path));
    } catch (error) {
      return errorResponse(error);
    }
  }
});

export { definition, execute };
