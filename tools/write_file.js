import { writeFileVerified } from '../utils/file-io.js';
import { defineTool } from '../utils/tool-schema.js';
import { canonicalTrackingWrite } from '../utils/tracking-fence.js';

/**
 * Overwrite a file with verified, atomic writes (see utils/file-io.js).
 *
 * A write that names one of the two tracking files is **normalised**: whatever the
 * caller supplied is re-rendered into the canonical document
 * (`utils/tracking-format.js`) before it lands, so `task.md` and
 * `implementation_plan.md` keep their shape no matter who drafts them
 * (`utils/tracking-fence.js`).
 */

const { definition, execute } = defineTool({
  name: 'write_file',
  description: 'Write content to a file, overwriting existing content. The write is atomic and verified byte-for-byte before success is reported. A write to task.md or implementation_plan.md is re-rendered in the canonical tracking shape (title, "status:" line, one "- [ ]" section), so a draft is normalised rather than stored verbatim.',
  parameters: {
    properties: {
      path: {
        type: 'string',
        description: 'The path to the file to write'
      },
      content: {
        type: 'string',
        description: 'The content to write to the file'
      }
    },
    required: ['path', 'content']
  },
  async execute(args) {
    try {
      const tracking = canonicalTrackingWrite(args.path, args.content);
      const content = tracking ? tracking.content : args.content;
      const result = writeFileVerified(args.path, content);
      return JSON.stringify({
        status: 'success',
        path: args.path,
        bytes: result.bytes,
        created: result.created,
        verified: true,
        ...(tracking ? { canonicalised: true, kind: tracking.kind } : {}),
        message: `Successfully wrote ${result.bytes} bytes to ${args.path}${result.created ? ' (new file)' : ''}.`
          + (tracking ? ' The tracking document was re-rendered in its canonical shape.' : '')
      });
    } catch (error) {
      const code = error.code || 'UNEXPECTED_ERROR';
      let guidance = null;
      if (code === 'INVALID_PATH') guidance = 'Use a relative path inside the project directory.';
      if (code === 'INVALID_CONTENT') guidance = 'The "content" argument must be a string.';
      return JSON.stringify({
        status: 'error',
        code,
        message: `write_file failed: ${error.message}`,
        ...(guidance ? { guidance } : {}),
        path: args?.path
      });
    }
  }
});

export { definition, execute };